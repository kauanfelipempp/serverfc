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
// Configurado para aceitar até 10 imagens por produto
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
    image: { type: String, required: true },      // Foto principal (capa)
    images: [String],                             // Galeria de fotos extras
    description: String,                          // Descrição detalhada
    material: String,                             // Composição/Material
    categoria: String,
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
    status: { type: String, default: 'Pendente' },
    trackingCode: { type: String, default: '' }
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

// --- ROTAS DE PRODUTOS ---

// Buscar todos os produtos
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find().sort({ createdAt: -1 });
        res.json(products);
    } catch (e) {
        res.status(500).json([]);
    }
});

// BUSCAR PRODUTO ÚNICO POR ID (NOVA ROTA)
app.get('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ error: "Produto não encontrado" });
        res.json(product);
    } catch (e) {
        res.status(500).json({ error: "Erro ao buscar detalhes do produto" });
    }
});

// CRIAR PRODUTO (ATUALIZADA PARA MÚLTIPLAS FOTOS)
app.post('/api/products', verifyAdmin, upload.array('imagens', 10), async (req, res) => {
    try {
        const { nome, preco, categoria, description, material, sizes, colors } = req.body;

        // Mapeia os caminhos de todas as fotos enviadas para o Cloudinary
        const imageUrls = req.files ? req.files.map(file => file.path) : [];

        const novoProduto = new Product({
            name: nome,
            price: Number(preco),
            image: imageUrls.length > 0 ? imageUrls[0] : "", // Primeira foto é a principal
            images: imageUrls,                               // Todas vão para o array de galeria
            categoria: categoria,
            description: description,
            material: material,
            sizes: JSON.parse(sizes || "[]"),
            colors: JSON.parse(colors || "[]")
        });

        await novoProduto.save();
        res.json({ success: true, produto: novoProduto });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Erro ao criar produto com múltiplas fotos" });
    }
});

// ATUALIZAR PRODUTO
app.put('/api/products/:id', verifyAdmin, upload.array('imagens', 10), async (req, res) => {
    try {
        const { nome, preco, categoria, description, material, sizes, colors } = req.body;

        let imageUrls = [];
        // Se novas imagens foram enviadas, usamos elas. Se não, mantemos as antigas enviadas via body
        if (req.files && req.files.length > 0) {
            imageUrls = req.files.map(file => file.path);
        } else {
            imageUrls = typeof req.body.images === 'string' ? JSON.parse(req.body.images) : req.body.images;
        }

        const dadosAtualizados = {
            name: nome,
            price: Number(preco),
            categoria: categoria,
            description: description,
            material: material,
            sizes: typeof sizes === 'string' ? JSON.parse(sizes) : sizes,
            colors: typeof colors === 'string' ? JSON.parse(colors) : colors,
            image: imageUrls[0],
            images: imageUrls
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

// --- ROTA PÚBLICA DE RASTREIO ---
app.get('/api/public/orders/:id', async (req, res) => {
    try {
        const queryId = req.params.id;
        let pedido = await Order.findById(queryId);
        if (!pedido) {
            pedido = await Order.findOne({ _id: { $regex: queryId + "$", $options: 'i' } });
        }
        if (!pedido) return res.status(404).json({ error: "Pedido não encontrado." });

        res.json({
            _id: pedido._id,
            status: pedido.status,
            data: pedido.data,
            cliente: { nome: pedido.cliente.nome },
            itens: pedido.itens.map(i => ({ nome: i.nome, qty: i.qty, size: i.size, color: i.color })),
            total: pedido.total,
            trackingCode: pedido.trackingCode || null
        });
    } catch (e) {
        res.status(400).json({ error: "Erro na busca." });
    }
});

// --- ROTAS DE CATEGORIAS ---
app.get('/api/categories', async (req, res) => {
    try {
        const categories = await Category.find().sort({ order: 1 });
        res.json(categories);
    } catch (e) { res.status(500).json({ error: "Erro ao buscar categorias" }); }
});

app.post('/api/categories', verifyAdmin, async (req, res) => {
    try {
        const cat = new Category(req.body);
        await cat.save();
        res.status(201).json(cat);
    } catch (e) { res.status(400).json({ error: "Erro ao criar categoria" }); }
});

app.delete('/api/categories/:id', verifyAdmin, async (req, res) => {
    try {
        await Category.findByIdAndDelete(req.params.id);
        res.json({ message: "Categoria removida com sucesso" });
    } catch (e) { res.status(400).json({ error: "Erro ao deletar categoria" }); }
});

// --- USUÁRIOS E AUTH ---
app.post('/api/register', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        const hash = await bcrypt.hash(senha, 10);
        const user = new User({ nome, email, senha: hash });
        await user.save();
        res.status(201).json({ message: "Registrado com sucesso!" });
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
    } catch (e) { res.status(500).json({ error: "Erro interno" }); }
});

// --- CHECKOUT E WEBHOOK ---
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

        res.json({ success: true, url: mpResponse.init_point });
    } catch (e) {
        res.status(500).json({ error: "Erro checkout" });
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

            await Order.findByIdAndUpdate(externalRef, { status: novoStatus });
        }
        res.sendStatus(200);
    } catch (e) { res.sendStatus(500); }
});

// --- ADMIN PEDIDOS ---
app.get('/api/orders', verifyAdmin, async (req, res) => {
    const orders = await Order.find().sort({ data: -1 });
    res.json(orders);
});

app.put('/api/orders/:id/status', verifyAdmin, async (req, res) => {
    try {
        const { status, trackingCode } = req.body;
        const pedido = await Order.findByIdAndUpdate(req.params.id, { status, trackingCode }, { new: true });
        res.json({ success: true, pedido });
    } catch (e) { res.status(500).json({ error: "Erro" }); }
});

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🔥 Servidor Rodando na porta ${PORT}`);
});