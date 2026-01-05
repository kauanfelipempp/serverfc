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

// --- CONFIGURAÇÃO MERCADO PAGO ---
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

const app = express();
const JWT_SECRET = process.env.JWT_SECRET;

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- CONFIGURAÇÃO DE UPLOAD ---
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => {
        const uniqueName = 'prod-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });

// --- CONEXÃO MONGODB ATLAS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Conectado"))
    .catch(err => console.error("❌ Erro Mongo:", err));

// --- CONFIGURAÇÃO DE EMAIL (NODEMAILER) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- SCHEMAS ---
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
    description: String,
    sizes: [String],
    colors: [String],
    createdAt: { type: Date, default: Date.now }
}));

const Coupon = mongoose.model('Coupon', new mongoose.Schema({
    code: { type: String, uppercase: true, unique: true },
    discount: Number,
    freeShipping: Boolean
}));

const Order = mongoose.model('Order', new mongoose.Schema({
    _id: String, // ID customizado (External Reference do MP)
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
    if (!token) return res.status(401).json({ error: "Acesso negado: Token ausente" });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.isAdmin) {
            req.user = decoded;
            next();
        } else {
            res.status(403).json({ error: "Acesso negado: Você não é admin" });
        }
    } catch (e) {
        res.status(400).json({ error: "Token inválido" });
    }
}

// --- ROTAS DE PRODUTOS ---

app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find().sort({ createdAt: -1 });
        const mapped = products.map(p => ({
            _id: p._id,
            nome: p.name || "Produto sem nome",
            preco: p.price || 0,
            imagem: p.image ? (p.image.startsWith('http') ? p.image : `http://localhost:3000/${p.image}`) : 'https://placehold.co/400x500',
            sizes: p.sizes || [],
            colors: p.colors || [],
            categoria: p.description || ""
        }));
        res.json(mapped);
    } catch (e) {
        console.error("Erro na rota GET /api/products:", e);
        res.status(500).json([]);
    }
});

app.post('/api/products', verifyAdmin, async (req, res) => {
    try {
        const { nome, preco, imagem, categoria, sizes, colors } = req.body;
        const novoProduto = new Product({
            name: nome, price: preco, image: imagem,
            description: categoria, sizes, colors
        });
        await novoProduto.save();
        res.json({ message: "Produto criado!", produto: novoProduto });
    } catch (e) {
        res.status(500).json({ error: "Erro ao criar produto" });
    }
});

app.put('/api/products/:id', verifyAdmin, async (req, res) => {
    try {
        const atualizado = await Product.findByIdAndUpdate(req.params.id, {
            name: req.body.nome,
            price: req.body.preco,
            image: req.body.imagem,
            description: req.body.categoria,
            sizes: req.body.sizes,
            colors: req.body.colors
        }, { new: true });
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

app.post('/api/upload', verifyAdmin, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
    res.json({ imageUrl: `uploads/${req.file.filename}` });
});

// --- ROTAS DE USUÁRIOS & AUTH ---

app.post('/api/register', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        const hash = await bcrypt.hash(senha, 10);
        const user = new User({ nome, email, senha: hash });
        await user.save();
        res.status(201).json({ message: "Registrado!" });
    } catch (e) { res.status(400).json({ error: "Email já cadastrado" }); }
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
    } catch (e) { res.status(500).json({ error: "Erro interno no servidor" }); }
});

app.get('/api/users', verifyAdmin, async (req, res) => {
    const users = await User.find({}, '-senha');
    res.json(users);
});

// --- CUPONS & FRETE ---

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
    } catch (e) {
        res.status(500).json({ error: "Erro ao deletar cupom" });
    }
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

// --- ROTAS DE PEDIDOS E CHECKOUT ---

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
                shipments: {
                    cost: Number(frete),
                    mode: 'not_specified',
                },
                payer: {
                    name: cliente.nome,
                    email: cliente.email
                },
                back_urls: {
                    success: "https://youtube.com",
                    failure: "https://youtube.com",
                    pending: "https://youtube.com"
                },
                auto_return: "approved",
                external_reference: externalReference,

                // NOTIFICATION URL (Troque ao fazer deploy)
                notification_url: "https://SEU-APP-NO-RENDER.onrender.com/api/webhook"
            }
        });

        // Salvar Pedido Inicial
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

        // Email 1: Pedido Recebido
        const listaItens = itens.map(i => `<li>${i.qty}x ${i.nome}</li>`).join('');
        transporter.sendMail({
            from: 'Fatal Company <loja@fatal.com>',
            to: cliente.email,
            subject: 'Pedido Recebido! Finalize o Pagamento 💠',
            html: `
                <div style="background:#111; color:#fff; padding:20px; font-family:sans-serif;">
                    <h2 style="color:#00bfff;">Pedido Recebido!</h2>
                    <p>Olá ${cliente.nome}, clique no link abaixo para pagar.</p>
                    <a href="${mpResponse.init_point}" style="background:#00bfff; color:white; padding:10px 20px; text-decoration:none; display:inline-block; margin:20px 0;">PAGAR AGORA</a>
                    <hr style="border:1px solid #333;">
                    <ul>${listaItens}</ul>
                    <p><strong>Total: R$ ${total.toFixed(2)}</strong></p>
                </div>`
        }).catch(err => console.error("Erro email pedido:", err));

        res.json({ success: true, url: mpResponse.init_point });

    } catch (e) {
        console.error("Erro MP:", e);
        res.status(500).json({ error: "Erro no checkout" });
    }
});

// WEBHOOK
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

            // Email 2: Pagamento Aprovado!
            if (status === 'approved' && pedidoAtualizado) {
                const cliente = pedidoAtualizado.cliente;

                transporter.sendMail({
                    from: 'Fatal Company <loja@fatal.com>',
                    to: cliente.email,
                    subject: 'Pagamento Aprovado! Seu pedido está sendo preparado 🚀',
                    html: `
                        <div style="background:#111; color:#fff; padding:20px; font-family:sans-serif;">
                            <h2 style="color:#00ff00;">Pagamento Confirmado!</h2>
                            <p>Olá <strong>${cliente.nome}</strong>, recebemos seu pagamento.</p>
                            <p>Seu pedido <strong>#${pedidoAtualizado._id.toString().slice(-6).toUpperCase()}</strong> já entrou para a fila de envio.</p>
                            <hr style="border:1px solid #333;">
                            <p>Você receberá outro e-mail com o código de rastreio assim que enviarmos.</p>
                        </div>`
                }).catch(err => console.error("Erro email webhook:", err));

                console.log(`✅ Pedido ${externalRef} atualizado para Aprovado via Webhook`);
            }
        }
        res.sendStatus(200);

    } catch (e) {
        console.error("Erro Webhook:", e);
        res.sendStatus(500);
    }
});

// ROTAS DE ADMIN (PEDIDOS) ATUALIZADA

app.get('/api/orders', verifyAdmin, async (req, res) => {
    try {
        const orders = await Order.find().sort({ data: -1 });
        res.json(orders);
    } catch (e) {
        res.status(500).json({ error: "Erro ao carregar pedidos" });
    }
});

// === ROTA ATUALIZADA: STATUS + TRACKING CODE ===
app.put('/api/orders/:id/status', verifyAdmin, async (req, res) => {
    try {
        const { status, trackingCode } = req.body; // Agora aceita código de rastreio

        // Atualiza o status do pedido
        const pedido = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });

        if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });

        // SE O STATUS FOR "ENVIADO", ENVIA O EMAIL COM RASTREIO
        if (status === 'Enviado') {
            const cliente = pedido.cliente;

            // Texto do rastreio (se você digitou ou não)
            const msgRastreio = trackingCode
                ? `<p style="font-size:1.2rem; background:#222; padding:10px; display:inline-block; border:1px dashed #fff;">Código de Rastreio: <strong>${trackingCode}</strong></p>`
                : `<p>Seu pedido saiu para entrega!</p>`;

            transporter.sendMail({
                from: 'Fatal Company <loja@fatal.com>',
                to: cliente.email,
                subject: 'Seu Pedido foi Enviado! 🚚',
                html: `
                    <div style="background:#050505; color:#fff; padding:30px; font-family:sans-serif; text-align:center;">
                        <h2 style="color:#00bfff; margin-bottom:10px;">PEDIDO ENVIADO</h2>
                        <p>Olá <strong>${cliente.nome}</strong>,</p>
                        <p>Temos ótimas notícias! Seus itens já estão com a transportadora.</p>
                        <br>
                        ${msgRastreio}
                        <br><br>
                        <p style="color:#888;">Em breve chegará no endereço: ${cliente.endereco}</p>
                        <hr style="border-color:#333; margin: 30px 0;">
                        <small>Obrigado por comprar na Fatal Company.</small>
                    </div>`
            }).catch(e => console.error("Erro ao enviar email de envio:", e));
        }

        res.json({ success: true, status });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Erro ao atualizar status" });
    }
});

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Servidor ON na porta ${PORT}`));