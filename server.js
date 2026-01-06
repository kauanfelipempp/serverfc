require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

// --- CONFIGURAÇÕES DE CLOUDINARY E MULTER ---
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET;

// Configuração Mercado Pago
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// Configuração Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_KEY,
    api_secret: process.env.CLOUDINARY_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'produtos_fatal',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    },
});
const upload = multer({ storage });

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONEXÃO MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Conectado com Sucesso"))
    .catch(err => console.error("❌ Erro ao conectar no Mongo:", err));

// --- CONFIGURAÇÃO DE EMAIL (Transporter) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- SCHEMAS (Modelos de Dados) ---
const User = mongoose.model('User', new mongoose.Schema({
    nome: String,
    email: { type: String, unique: true, required: true },
    senha: { type: String, required: true },
    isAdmin: { type: Boolean, default: false }
}));

const Product = mongoose.model('Product', new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    image: { type: String, required: true },
    categoria: String, // Usado como categoria nos produtos
    sizes: [String],
    colors: [String],
    createdAt: { type: Date, default: Date.now }
}));

const Category = mongoose.model('Category', new mongoose.Schema({
    title: { type: String, required: true },
    categoria: String,
    order: { type: Number, default: 0 }
}));

const Coupon = mongoose.model('Coupon', new mongoose.Schema({
    code: { type: String, uppercase: true, unique: true },
    discount: Number,
    freeShipping: Boolean
}));

const Order = mongoose.model('Order', new mongoose.Schema({
    _id: String,
    cliente: Object,
    itens: Array,
    subtotal: Number,
    frete: Number,
    desconto: Number,
    total: Number,
    data: { type: Date, default: Date.now },
    status: { type: String, default: 'Pendente' }
}));

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
function verifyAdmin(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: "Acesso negado. Token não fornecido." });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.isAdmin) {
            req.user = decoded;
            next();
        } else {
            res.status(403).json({ error: "Acesso proibido. Requer privilégios de admin." });
        }
    } catch (e) {
        res.status(400).json({ error: "Token inválido ou expirado." });
    }
}

// --- ROTAS DE CATEGORIAS (Unificadas) ---
// ROTA PÚBLICA DE RASTREIO
// Esta rota não precisa de "verifyAdmin" para o cliente poder usar
app.get('/api/public/orders/:id', async (req, res) => {
    try {
        const pedido = await Order.findById(req.params.id);

        if (!pedido) {
            return res.status(404).json({ error: "Pedido não encontrado" });
        }

        // Retorna apenas o que o cliente precisa ver (segurança)
        res.json({
            _id: pedido._id,
            status: pedido.status,
            data: pedido.data,
            cliente: { nome: pedido.cliente.nome },
            itens: pedido.itens,
            total: pedido.total,
            trackingCode: pedido.trackingCode // Se você tiver esse campo
        });
    } catch (e) {
        // Se o ID digitado não for um ID válido do MongoDB, ele cai aqui
        res.status(404).json({ error: "Código de pedido inválido ou não encontrado" });
    }
});
// Esta rota permite que o cliente veja o status sem precisar de login
app.get('/api/public/orders/:id', async (req, res) => {
    try {
        // Procura o pedido pelo ID (o código que o cliente digita)
        const pedido = await Order.findById(req.params.id);

        if (!pedido) {
            return res.status(404).json({ error: "Pedido não encontrado" });
        }

        // Retornamos apenas os dados seguros para o cliente ver
        res.json({
            _id: pedido._id,
            status: pedido.status,
            data: pedido.data,
            cliente: {
                nome: pedido.cliente.nome
            },
            itens: pedido.itens.map(i => ({
                nome: i.nome,
                qty: i.qty,
                size: i.size,
                color: i.color
            })),
            total: pedido.total
        });
    } catch (e) {
        // Se o ID for inválido (menos caracteres que o padrão do Mongo), cai aqui
        res.status(400).json({ error: "Código de pedido inválido" });
    }
});



app.get('/api/categories', async (req, res) => {
    try {
        const categories = await Category.find().sort({ order: 1 });
        res.json(categories);
    } catch (e) {
        res.status(500).json({ error: "Erro ao buscar categorias" });
    }
});

app.post('/api/categories', verifyAdmin, async (req, res) => {
    try {
        const cat = new Category(req.body);
        await cat.save();
        res.status(201).json(cat);
    } catch (e) {
        res.status(400).json({ error: "Erro ao criar categoria" });
    }
});

app.delete('/api/categories/:id', verifyAdmin, async (req, res) => {
    try {
        await Category.findByIdAndDelete(req.params.id);
        res.json({ message: "Categoria removida com sucesso" });
    } catch (e) {
        res.status(400).json({ error: "Erro ao deletar categoria" });
    }
});

// --- ROTAS DE PRODUTOS ---
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find().sort({ createdAt: -1 });
        const mapped = products.map(p => {
            let finalImage = p.image;
            if (p.image && !p.image.startsWith('http')) {
                const cleanPath = p.image.replace(/\\/g, '/');
                finalImage = `https://serverfc.onrender.com/${cleanPath}`;
            }
            return {
                _id: p._id,
                nome: p.name,
                preco: p.price,
                imagem: finalImage,
                sizes: p.sizes || [],
                colors: p.colors || [],
                categoria: p.description || ""
            };
        });
        res.json(mapped);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post('/api/products', verifyAdmin, upload.single('imagem'), async (req, res) => {
    try {
        const { nome, preco, categoria, sizes, colors } = req.body;
        const imageUrl = req.file ? req.file.path : "";

        const novoProduto = new Product({
            name: nome,
            price: Number(preco),
            image: imageUrl,
            description: categoria,
            sizes: JSON.parse(sizes || "[]"),
            colors: JSON.parse(colors || "[]")
        });

        await novoProduto.save();
        res.json({ success: true, produto: novoProduto });
    } catch (e) {
        res.status(500).json({ error: "Erro ao criar produto" });
    }
});

app.put('/api/products/:id', verifyAdmin, upload.single('imagem'), async (req, res) => {
    try {
        const { nome, preco, categoria, sizes, colors } = req.body;
        const imageUrl = req.file ? req.file.path : req.body.image;

        const dadosAtualizados = {
            name: nome,
            price: Number(preco),
            description: categoria,
            sizes: typeof sizes === 'string' ? JSON.parse(sizes) : sizes,
            colors: typeof colors === 'string' ? JSON.parse(colors) : colors,
            image: imageUrl
        };

        const atualizado = await Product.findByIdAndUpdate(req.params.id, dadosAtualizados, { new: true });
        res.json({ message: "Produto atualizado!", produto: atualizado });
    } catch (e) {
        res.status(500).json({ error: "Erro ao atualizar" });
    }
});

app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ message: "Removido" });
    } catch (e) {
        res.status(500).json({ error: "Erro ao deletar" });
    }
});

// --- ROTAS DE USUÁRIO E AUTENTICAÇÃO ---
app.post('/api/register', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        const hash = await bcrypt.hash(senha, 10);
        const user = new User({ nome, email, senha: hash });
        await user.save();
        res.status(201).json({ message: "Registrado com sucesso!" });
    } catch (e) {
        res.status(400).json({ error: "Email já cadastrado" });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const user = await User.findOne({ email });
        if (user && await bcrypt.compare(senha, user.senha)) {
            const token = jwt.sign({ id: user._id, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '24h' });
            res.json({ token, nome: user.nome, isAdmin: user.isAdmin });
        } else {
            res.status(401).json({ error: "Credenciais inválidas" });
        }
    } catch (e) {
        res.status(500).json({ error: "Erro interno no servidor" });
    }
});

app.get('/api/users', verifyAdmin, async (req, res) => {
    const users = await User.find({}, '-senha');
    res.json(users);
});

// --- CUPONS E FRETE ---
app.post('/api/coupons', verifyAdmin, async (req, res) => {
    try {
        const novo = new Coupon(req.body);
        await novo.save();
        res.json({ message: "Cupom criado!" });
    } catch (e) { res.status(500).json({ error: "Erro ao criar cupom" }); }
});

app.get('/api/coupons', verifyAdmin, async (req, res) => {
    res.json(await Coupon.find());
});

app.delete('/api/coupons/:id', verifyAdmin, async (req, res) => {
    try {
        await Coupon.findByIdAndDelete(req.params.id);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "Erro ao deletar" }); }
});

app.post('/api/validate-coupon', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.json({ valid: false });
    const coupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (coupon) res.json({ valid: true, discount: coupon.discount, freeShipping: coupon.freeShipping });
    else res.json({ valid: false });
});

app.post('/api/shipping', async (req, res) => {
    const { cep } = req.body;
    const price = (cep && cep.startsWith('0')) ? 10.00 : 25.00;
    res.json({ price });
});

// --- CHECKOUT E MERCADO PAGO ---
app.post('/api/checkout', async (req, res) => {
    try {
        const { cliente, itens, total, frete, desconto } = req.body;
        const totalProdutos = itens.reduce((acc, item) => acc + (Number(item.preco) * Number(item.qty)), 0);

        const itemsParaMP = itens.map(item => {
            const precoOriginal = Number(item.preco);
            let precoFinal = precoOriginal;
            if (desconto > 0 && totalProdutos > 0) {
                const proporcao = precoOriginal / totalProdutos;
                const descontoDoItem = desconto * proporcao;
                precoFinal = precoOriginal - (descontoDoItem / item.qty);
            }
            return {
                title: item.nome,
                quantity: Number(item.qty),
                unit_price: Number(precoFinal.toFixed(2)),
                currency_id: 'BRL',
                picture_url: item.imagem
            };
        });

        const preference = new Preference(client);
        const externalReference = new mongoose.Types.ObjectId().toString();

        const mpResponse = await preference.create({
            body: {
                items: itemsParaMP,
                shipments: { cost: Number(frete), mode: 'not_specified' },
                payer: { name: cliente.nome, email: cliente.email },
                back_urls: {
                    success: "https://www.fatalcompany.store/backurl/sucesso.html",
                    failure: "https://www.fatalcompany.store/backurl/erro.html",
                    pending: "https://www.fatalcompany.store/backurl/pendente.html"
                },
                auto_return: "approved",
                external_reference: externalReference,
                notification_url: "https://serverfc.onrender.com/api/webhook"
            }
        });

        const novoPedido = new Order({
            _id: externalReference,
            cliente,
            itens,
            subtotal: totalProdutos,
            frete,
            desconto,
            total,
            status: 'Aguardando Pagamento (MP)',
            data: new Date()
        });
        await novoPedido.save();

        const listaItens = itens.map(i => `<li>${i.qty}x ${i.nome}</li>`).join('');
        transporter.sendMail({
            from: 'Fatal Company <loja@fatal.com>',
            to: cliente.email,
            subject: 'Pedido Recebido! 💠',
            html: `
                <div style="background:#111; color:#fff; padding:20px; font-family:sans-serif;">
                    <h2 style="color:#00bfff;">Pedido Recebido!</h2>
                    <p>Olá ${cliente.nome}, clique no link abaixo para realizar o pagamento.</p>
                    <a href="${mpResponse.init_point}" style="background:#00bfff; color:white; padding:10px 20px; text-decoration:none; display:inline-block; margin:20px 0;">PAGAR AGORA</a>
                    <hr style="border:1px solid #333;">
                    <ul>${listaItens}</ul>
                    <p><strong>Total: R$ ${total.toFixed(2)}</strong></p>
                </div>`
        }).catch(err => console.error("Erro email pedido:", err));

        res.json({ success: true, url: mpResponse.init_point });

    } catch (e) {
        console.error("Erro MP:", e);
        res.status(500).json({ error: "Erro ao processar checkout" });
    }
});

app.post('/api/webhook', async (req, res) => {
    const { action, data } = req.body;
    try {
        if (action === 'payment.created' || action === 'payment.updated') {
            const payment = new Payment(client);
            const paymentInfo = await payment.get({ id: data.id });
            const status = paymentInfo.status;
            const externalRef = paymentInfo.external_reference;

            let novoStatus = 'Aguardando Pagamento (MP)';
            if (status === 'approved') novoStatus = 'Aprovado';
            if (status === 'rejected') novoStatus = 'Recusado';

            const pedidoAtualizado = await Order.findByIdAndUpdate(externalRef, { status: novoStatus }, { new: true });

            if (status === 'approved' && pedidoAtualizado) {
                const cliente = pedidoAtualizado.cliente;
                transporter.sendMail({
                    from: 'Fatal Company <loja@fatal.com>',
                    to: cliente.email,
                    subject: 'Pagamento Aprovado! 🚀',
                    html: `<div style="background:#111; color:#fff; padding:20px; font-family:sans-serif;">
                            <h2 style="color:#00ff00;">Pagamento Confirmado!</h2>
                            <p>Olá <strong>${cliente.nome}</strong>, seu pedido #${pedidoAtualizado._id.toString().slice(-6).toUpperCase()} está sendo preparado.</p>
                        </div>`
                }).catch(err => console.error("Erro email webhook:", err));
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Erro Webhook:", e);
        res.sendStatus(500);
    }
});

// --- GESTÃO DE PEDIDOS (ADMIN) ---
app.get('/api/orders', verifyAdmin, async (req, res) => {
    try {
        const orders = await Order.find().sort({ data: -1 });
        res.json(orders);
    } catch (e) { res.status(500).json({ error: "Erro ao carregar pedidos" }); }
});

app.put('/api/orders/:id/status', verifyAdmin, async (req, res) => {
    try {
        const { status, trackingCode } = req.body;
        const pedido = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });

        if (status === 'Enviado') {
            const cliente = pedido.cliente;
            transporter.sendMail({
                from: 'Fatal Company <loja@fatal.com>',
                to: cliente.email,
                subject: 'Pedido Enviado! 🚚',
                html: `<div style="background:#050505; color:#fff; padding:30px; font-family:sans-serif; text-align:center;">
                        <h2>SEU PEDIDO FOI ENVIADO!</h2>
                        <p>Código de Rastreio: <strong>${trackingCode || 'Será atualizado em breve'}</strong></p>
                    </div>`
            }).catch(e => console.error(e));
        }
        res.json({ success: true, status });
    } catch (e) { res.status(500).json({ error: "Erro ao atualizar status" }); }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🔥 Servidor Rodando na porta ${PORT}`);
    console.log(`📌 Endpoints de Categoria e Produtos Ativados.`);
});