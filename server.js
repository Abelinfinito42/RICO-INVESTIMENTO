﻿/*
RICO INVESTIMENTO - server.js atualizado
- OTP agora formata número para +244
 - OTP guardado temporariamente na memória do servidor por 5 minutos
 - Logs detalhados
*/

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const https = require('https');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const fetch = (...args) =>
    import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'site')));

// CONFIGURAÇÃO SUPABASE
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgwxtbxgxozxicmipadr.supabase.co';
// Em producao use SUPABASE_SERVICE_ROLE_KEY apenas no servidor.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || 'sb_publishable_cAFfrLoGx4MbG0J3IXwINw_f6NOuPkQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CONFIGS
const DEPOSITO_API_KEY = process.env.DEPOSITO_API_KEY || '32y3103KsiiaoL57dt38blJ1TWKxeDrUYucBeraKgI47hr2RbsJBOsJEtScy590203';
const DEPOSITO_DESTINO_NUMERO = '926240472';
const DEPOSITO_DESTINO_IBAN = '';
const DEPOSITO_TAXA_KZ = 1;
const DEPOSITO_SUDO_URL = 'https://comprovativos.sudomakes.com/validar/';
const DEPOSITO_MAX_FILE_MB = 10;
const DEPOSITO_TIMEOUT_MS = 25000;
const VALOR_MINIMO_LEVANTAMENTO = 50;

const SMS_API_URL = 'https://smsapi.sudomakes.com/api/enviar-sms';
const OTP_API_URL = 'https://smsapi.sudomakes.com/api/enviar-otp';
const SMS_API_KEY = process.env.SMS_API_KEY || 'b/XqoDmBgf9lNDlP7gE7qpMNobETZ0ZWNekINr559KcwNZQ477TCj6yJlKRTH7MO';
// A API usada pelo código de referência devolve o OTP no campo "otp".
// Pode ser substituída em produção pela variável KASSALA_API_KEY.
const KASSALA_API_KEY = process.env.KASSALA_API_KEY || 'VFlkCkvV+LdsirzvfB4J6/rGl6eMItrUQYR3/HsVRb42yBJAM+p3urmKwDdsF0l3duva/fyFWvkjIumDcE/uagO53vdAj74CuXiNZOVMkwc=';
// Em producao, configure ADMIN_PASSWORD no Render. Nunca usar uma senha padrao.
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const OTP_EXPIRA_MS = 5 * 60 * 1000;
const OTP_REENVIO_MS = 60 * 1000;
const OTP_MAX_TENTATIVAS = 5;
const OTP_IP_WINDOW_MS = 10 * 60 * 1000;
const OTP_IP_MAX_REQUESTS = 10;
const otpStore = new Map();
const otpIpStore = new Map();
const sessoes = new Map();
const pedidosFinanceiros = new Map();
const SESSAO_EXPIRA_MS = 7 * 24 * 60 * 60 * 1000;
const PEDIDO_IDEMPOTENCIA_MS = 15 * 60 * 1000;
const VALOR_MINIMO_TRANSFERENCIA = 500;
const VALOR_MINIMO_INVESTIMENTO = 50;

// Remove códigos expirados para não acumular dados na memória do processo.
const otpCleanupTimer = setInterval(() => {
    const agora = Date.now();
    for (const [telefone, registro] of otpStore.entries()) {
        if (!registro || registro.expira <= agora) otpStore.delete(telefone);
    }
}, 60 * 1000);
otpCleanupTimer.unref?.();

function toNumberSafe(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n)? n : fallback;
}
function arredondar2(value) { return Number(toNumberSafe(value).toFixed(2)); }
function formatarNumeroSMS(destinatario) {
    const numero = String(destinatario || '').replace(/\D/g, '');
    if (!numero) return '';
    return numero.startsWith('244')? `+${numero}` : `+244${numero}`;
}
async function enviarSMS(destinatario, mensagem) {
    if (!SMS_API_KEY) return null;
    const numeroFormatado = formatarNumeroSMS(destinatario);
    if (!numeroFormatado) return null;
    try {
        const response = await fetch(SMS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ api_key: SMS_API_KEY, destinatario: numeroFormatado, mensagem })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) console.error('Erro SMS:', data);
        return data;
    } catch (error) { console.error('Erro SMS:', error.message); return null; }
}
function gerarCodigoOTP() { return String(crypto.randomInt(100000, 1000000)); }
function validarDadosCadastro({ nome, telefone, senha }) {
    const nomeLimpo = normalizarTexto(nome);
    const telefoneAssinatura = assinaturaTelefone(telefone);
    const senhaLimpa = String(senha || '').trim();
    if (nomeLimpo.split(/\s+/).filter(Boolean).length < 2) return { error: 'Insira nome e apelido.' };
    if (!/^9\d{8}$/.test(telefoneAssinatura)) return { error: 'Numero de telemovel invalido.' };
    if (senhaLimpa.length < 5) return { error: 'A palavra-passe deve ter pelo menos 5 caracteres.' };
    return { nomeLimpo, telefoneAssinatura, senhaLimpa };
}
function chamarAPIKassala(caminho, payload) {
    return new Promise((resolve, reject) => {
        const corpo = JSON.stringify(payload);
        const pedido = https.request({
            hostname: 'smsapi.sudomakes.com',
            path: caminho,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(corpo)
            },
            timeout: 15000
        }, (resposta) => {
            let texto = '';
            resposta.setEncoding('utf8');
            resposta.on('data', (parte) => { texto += parte; });
            resposta.on('end', () => {
                try {
                    resolve(texto ? JSON.parse(texto) : {});
                } catch {
                    resolve({ status: -1, log: texto });
                }
            });
        });

        pedido.on('timeout', () => pedido.destroy(new Error('Tempo limite da API OTP excedido.')));
        pedido.on('error', reject);
        pedido.write(corpo);
        pedido.end();
    });
}

function limitarPedidosOTP(req) {
    const ip = req.ip || req.socket.remoteAddress || 'desconhecido';
    const agora = Date.now();
    const registro = otpIpStore.get(ip);

    if (!registro || agora - registro.inicio >= OTP_IP_WINDOW_MS) {
        otpIpStore.set(ip, { inicio: agora, total: 1 });
        return null;
    }

    if (registro.total >= OTP_IP_MAX_REQUESTS) {
        return 'Muitos pedidos de SMS. Tente novamente mais tarde.';
    }

    registro.total += 1;
    return null;
}

async function enviarOTPCadastro(destinatario) {
    if (!KASSALA_API_KEY) throw new Error('Chave da API OTP nao configurada.');
    const telefone = assinaturaTelefone(destinatario);
    const resposta = await chamarAPIKassala('/api/enviar-otp', {
        api_key: KASSALA_API_KEY,
        destinatario: telefone
    });

    console.log('[OTP] envio para', telefone, 'status', resposta.status);
    if (Number(resposta.status) !== 1 || !resposta.otp) {
        const mensagem = resposta.log || resposta.erro || resposta.mensagem || 'Falha ao enviar codigo OTP.';
        throw new Error(String(mensagem));
    }

    return String(resposta.otp);
}
const depositoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: DEPOSITO_MAX_FILE_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const isPdf = file.mimetype === 'application/pdf';
        const isImage = file.mimetype.startsWith('image/');
        if (!isPdf &&!isImage) return cb(new Error('Tipo de arquivo nao suportado. Envie PDF ou imagem.'));
        return cb(null, true);
    },
});

const usuariosOnline = new Map();
io.on('connection', (socket) => {
    socket.on('registrar-online', (telefone) => {
        const chave = assinaturaTelefone(telefone);
        if (!chave) return;
        socket.data.telefoneKey = chave;
        usuariosOnline.set(chave, socket.id);
        console.log(`📱 Usuário ${telefone} está online.`);
    });
    socket.on('disconnect', () => {
        const key = socket.data.telefoneKey;
        if (key && usuariosOnline.get(key) === socket.id) usuariosOnline.delete(key);
    });
});
function notificarSaldoUsuario(telefone, payload) {
    const key = assinaturaTelefone(telefone);
    if (!key) return;
    const socketDestino = usuariosOnline.get(key);
    if (socketDestino) io.to(socketDestino).emit('atualizar-saldo', payload);
}
function normalizarDigitos(value) { return String(value || '').replace(/\D/g, ''); }
function assinaturaTelefone(value) {
    const digitos = normalizarDigitos(value);
    if (!digitos) return '';
    return digitos.length > 9? digitos.slice(-9) : digitos;
}
function gerarVariacoesTelefone(value) {
    const assinatura = assinaturaTelefone(value);
    const completo = normalizarDigitos(value);
    if (!assinatura &&!completo) return [];
    return [...new Set([assinatura, `+244${assinatura}`, `244${assinatura}`, `0${assinatura}`, completo, `+${completo}`].filter(Boolean))];
}
async function buscarUsuariosPorTelefone(telefone, colunas = '*') {
    const variacoes = gerarVariacoesTelefone(telefone);
    const assinatura = assinaturaTelefone(telefone);
    if (!variacoes.length ||!assinatura) return [];
    const { data: porIgualdade, error: erroEq } = await supabase.from('usuarios').select(colunas).in('telefone', variacoes);
    if (erroEq) throw erroEq;
    if (porIgualdade && porIgualdade.length > 0) return porIgualdade;
    const { data: porAssinatura, error: erroAssinatura } = await supabase.from('usuarios').select(colunas).like('telefone', `%${assinatura}`);
    if (erroAssinatura) throw erroAssinatura;
    return porAssinatura || [];
}
async function buscarUsuarioPorTelefone(telefone, colunas = '*') {
    const lista = await buscarUsuariosPorTelefone(telefone, colunas);
    return lista[0] || null;
}
function normalizarTexto(valor) { return String(valor || '').trim(); }

function tipoTransacao(tx, userId) {
    const remetente = String(tx.remetente_nome || '').toLowerCase();
    const destinatario = String(tx.destinatario_nome || '').toLowerCase();
    const valor = toNumberSafe(tx.valor);
    if (remetente.includes('deposito') || remetente.includes('suporte')) return 'deposito';
    if (remetente.includes('ganho do investimento')) return 'ganho';
    if (remetente.includes('cancelamento de investimento')) return 'cancelamento_investimento';
    if (remetente.includes('bônus') || remetente.includes('bonus')) return 'bonus';
    if (remetente.includes('investimento') || destinatario.includes('investimento')) return 'investimento';
    if (Number(tx.remetente_id) === Number(userId)) return 'enviado';
    if (Number(tx.destinatario_id) === Number(userId)) return 'recebido';
    return valor >= 0 ? 'recebido' : 'enviado';
}

function tituloTransacao(tx, userId, tipo) {
    if (tipo === 'enviado') return `Transferencia para ${tx.destinatario_nome || 'utilizador'}`;
    if (tipo === 'recebido') return `Transferencia de ${tx.remetente_nome || 'utilizador'}`;
    if (tipo === 'deposito') return 'Deposito automatico';
    if (tipo === 'investimento') return 'Aplicacao em investimento';
    if (tipo === 'ganho') return 'Ganho do investimento';
    if (tipo === 'cancelamento_investimento') return 'Cancelamento de investimento';
    return tx.remetente_nome || tx.destinatario_nome || 'Movimento';
}

function normalizarIban(valor) { return normalizarTexto(valor).replace(/\s+/g, '').toUpperCase(); }

function obterValorChave(data, chaves) {
    if (!data || typeof data !== 'object') return null;
    const mapa = {};
    Object.keys(data).forEach((chave) => { mapa[String(chave).toUpperCase()] = data[chave]; });
    for (const chave of chaves) {
        const valor = mapa[String(chave).toUpperCase()];
        if (valor !== undefined && valor !== null && String(valor).trim() !== '') return valor;
    }
    return null;
}

function parseValorMonetario(valorRaw) {
    if (valorRaw === undefined || valorRaw === null) return NaN;
    let texto = String(valorRaw).replace(/[^\d,.-]/g, '');
    if (!texto) return NaN;
    if (texto.includes(',') && texto.includes('.')) texto = texto.replace(/\./g, '').replace(',', '.');
    else if (texto.includes(',')) texto = texto.replace(',', '.');
    const numero = Number.parseFloat(texto);
    return Number.isFinite(numero) ? numero : NaN;
}

function extrairTransferenciaId(data, respostaTexto) {
    const id = obterValorChave(data, ['ID_TRANSACAO', 'IDTRANSACAO', 'TRANSACAO_ID', 'TRANS_ID', 'REFERENCIA', 'REF', 'RECIBO', 'NUM_TRANSACAO', 'ID', 'TXID', 'TID']);
    if (id) return String(id);
    const match = String(respostaTexto || '').match(/(ID|REF|TRANSACAO|TRANSAC)[^0-9]*([0-9]{6,})/i);
    if (match?.[2]) return String(match[2]);
    if (respostaTexto) return `hash-${crypto.createHash('sha256').update(respostaTexto).digest('hex').slice(0, 32)}`;
    return null;
}

function extrairValorComprovativo(data, respostaTexto) {
    const valor = obterValorChave(data, ['MONTANTE', 'VALOR', 'AMOUNT', 'TOTAL', 'QUANTIA', 'VALOR_PAGO', 'VALOR_TOTAL']);
    let numero = parseValorMonetario(valor);
    if (!Number.isFinite(numero)) {
        const match = String(respostaTexto || '').match(/(\d[\d.,]{2,})\s*(KZ|AOA)/i);
        if (match?.[1]) numero = parseValorMonetario(match[1]);
    }
    return numero;
}

function validarDestinoComprovativo(respostaTexto) {
    const bruto = String(respostaTexto || '');
    const texto = bruto.replace(/\s+/g, '').toUpperCase();
    const numeros = bruto.replace(/\D/g, '');
    const numeroAlvo = normalizarTexto(DEPOSITO_DESTINO_NUMERO);
    const ibanAlvo = normalizarIban(DEPOSITO_DESTINO_IBAN);
    if (numeroAlvo && numeros.includes(numeroAlvo)) return { ok: true, tipo: 'numero', valor: numeroAlvo };
    if (ibanAlvo && texto.includes(ibanAlvo)) return { ok: true, tipo: 'iban', valor: ibanAlvo };
    return { ok: false, tipo: null, valor: null };
}

function exigirAdmin(req, res) {
    const senha = String(req.get('x-admin-password') || req.body?.senhaAdmin || req.body?.senha || '').trim();
    if (!ADMIN_PASSWORD || senha !== ADMIN_PASSWORD) {
        res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
        return false;
    }
    return true;
}

function criarSessao(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessoes.set(token, { userId: Number(userId), expira: Date.now() + SESSAO_EXPIRA_MS });
    return token;
}

function obterSessao(req) {
    const cabecalho = String(req.get('authorization') || '');
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : String(req.get('x-session-token') || '').trim();
    if (!token) return null;
    const sessao = sessoes.get(token);
    if (!sessao) return null;
    if (sessao.expira <= Date.now()) {
        sessoes.delete(token);
        return null;
    }
    sessao.expira = Date.now() + SESSAO_EXPIRA_MS;
    return { ...sessao, token };
}

function exigirSessao(req, res) {
    const sessao = obterSessao(req);
    if (!sessao) {
        res.status(401).json({ success: false, error: 'Sessao expirada. Faca login novamente.' });
        return null;
    }
    return sessao;
}

function bloquearPedidoDuplicado(req, res, escopo, userId) {
    const requestId = String(req.get('x-request-id') || req.body.requestId || '').trim();
    if (!/^[A-Za-z0-9._:-]{16,120}$/.test(requestId)) {
        res.status(400).json({ success: false, error: 'Identificador de operacao invalido ou ausente.' });
        return true;
    }

    const chave = `${escopo}:${Number(userId)}:${requestId}`;
    if (pedidosFinanceiros.has(chave)) {
        res.status(409).json({ success: false, error: 'Esta operacao ja esta em processamento ou ja foi enviada.' });
        return true;
    }

    pedidosFinanceiros.set(chave, Date.now());
    setTimeout(() => pedidosFinanceiros.delete(chave), PEDIDO_IDEMPOTENCIA_MS).unref?.();
    return false;
}

function resultadoRpc(data) {
    return Array.isArray(data) ? data[0] : data;
}

async function chamarRpc(nome, parametros) {
    const { data, error } = await supabase.rpc(nome, parametros);
    if (error) throw error;
    return resultadoRpc(data);
}

// --- LEVANTAMENTOS ---
// O mínimo é validado no servidor. Não confiar na validação do HTML.
app.post('/levantamentos/solicitar', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const userId = sessao.userId;
    if (bloquearPedidoDuplicado(req, res, 'levantamento', userId)) return;
    const valorTexto = String(req.body.valor ?? '').trim().replace(',', '.');
    const valor = Number(valorTexto);
    const metodo = String(req.body.metodo || '').trim().toLowerCase();
    const unitelTelefone = String(req.body.unitelTelefone || '').replace(/\D/g, '');
    const iban = String(req.body.iban || '').replace(/\D/g, '');
    const beneficiarioNome = String(req.body.beneficiarioNome || '').trim();

    if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(valor) || valor <= 0 || !metodo) {
        return res.status(400).json({ success: false, error: 'Dados de levantamento invalidos.' });
    }

    if (valor < VALOR_MINIMO_LEVANTAMENTO) {
        return res.status(400).json({
            success: false,
            error: `O valor minimo para levantamento e ${VALOR_MINIMO_LEVANTAMENTO.toFixed(2)} KZ.`
        });
    }

    if (!['unitel_money', 'iban'].includes(metodo)) {
        return res.status(400).json({ success: false, error: 'Metodo de levantamento invalido.' });
    }

    if (metodo === 'unitel_money' && !/^9\d{8}$/.test(unitelTelefone)) {
        return res.status(400).json({ success: false, error: 'Numero Unitel Money invalido.' });
    }

    if (metodo === 'iban') {
        if (!/^\d{21}$/.test(iban)) {
            return res.status(400).json({ success: false, error: 'IBAN invalido. Deve conter 21 numeros.' });
        }
        if (beneficiarioNome.length < 3) {
            return res.status(400).json({ success: false, error: 'Nome do beneficiario invalido.' });
        }
    }

    try {
        const { data: usuario, error: usuarioError } = await supabase
            .from('usuarios')
            .select('id, nome_completo, telefone, bloqueado')
            .eq('id', userId)
            .maybeSingle();

        if (usuarioError) throw usuarioError;
        if (!usuario) return res.status(404).json({ success: false, error: 'Usuario nao encontrado.' });
        if (usuario.bloqueado) return res.status(403).json({ success: false, error: 'Conta bloqueada.' });

        // A RPC faz o bloqueio da linha, verifica saldo e desconta/inserta de forma atomica.
        const { data: resultadoRpc, error: rpcError } = await supabase.rpc('solicitar_saque_v2', {
            p_user_id: userId,
            p_valor: arredondar2(valor),
            p_metodo: metodo,
            p_unitel: metodo === 'unitel_money' ? unitelTelefone : null,
            p_iban: metodo === 'iban' ? iban : null,
            p_beneficiario: metodo === 'iban' ? beneficiarioNome : null,
            p_user_nome: usuario.nome_completo || '',
            p_user_telefone: usuario.telefone || ''
        });

        if (rpcError) throw rpcError;
        const resultado = Array.isArray(resultadoRpc) ? resultadoRpc[0] : resultadoRpc;

        if (!resultado || resultado.success !== true) {
            return res.status(400).json({
                success: false,
                error: resultado?.error || 'Nao foi possivel solicitar o levantamento.'
            });
        }

        notificarSaldoUsuario(usuario.telefone, {
            novoSaldo: resultado.novoSaldo,
            mensagem: `Levantamento de ${arredondar2(valor).toFixed(2)} KZ solicitado com sucesso.`
        });
        io.emit('atualizar-levantamentos', {
            userId,
            levantamentoId: resultado.levantamentoId,
            status: 'pendente'
        });

        return res.json({
            success: true,
            novoSaldo: resultado.novoSaldo,
            levantamentoId: resultado.levantamentoId
        });
    } catch (err) {
        console.error('Erro ao solicitar levantamento:', err);
        return res.status(500).json({ success: false, error: 'Erro ao solicitar levantamento.' });
    }
});

// --- AUTENTICACAO E OPERACOES FINANCEIRAS ---
app.post('/auth/login', async (req, res) => {
    const telefone = assinaturaTelefone(req.body.telefone);
    const senha = String(req.body.senha || '');
    if (!/^9\d{8}$/.test(telefone) || !senha) {
        return res.status(400).json({ success: false, error: 'Dados de acesso invalidos.' });
    }

    try {
        const { data: usuario, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('telefone', telefone)
            .maybeSingle();
        if (error) throw error;
        if (!usuario || String(usuario.senha) !== senha) {
            return res.status(401).json({ success: false, error: 'Dados incorretos.' });
        }
        if (usuario.bloqueado) return res.status(403).json({ success: false, error: 'Conta bloqueada.' });

        const sessionToken = criarSessao(usuario.id);
        const { senha: _senha, ...usuarioSeguro } = usuario;
        return res.json({ success: true, usuario: { ...usuarioSeguro, sessionToken } });
    } catch (err) {
        console.error('Erro no login:', err);
        return res.status(500).json({ success: false, error: 'Erro no servidor.' });
    }
});

app.get('/buscar-usuario/:telefone', async (req, res) => {
    if (!exigirSessao(req, res)) return;
    try {
        const usuario = await buscarUsuarioPorTelefone(req.params.telefone, 'id, nome_completo, telefone');
        if (!usuario) return res.status(404).json({ success: false, error: 'Usuario nao encontrado.' });
        return res.json(usuario);
    } catch (err) {
        console.error('Erro ao buscar usuario:', err);
        return res.status(500).json({ success: false, error: 'Erro ao buscar usuario.' });
    }
});

app.get('/dados-bancarios/:userId', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId !== sessao.userId) {
        return res.status(403).json({ success: false, error: 'Operacao nao autorizada.' });
    }
    try {
        const { data, error } = await supabase
            .from('usuarios')
            .select('id, unitel_money, iban, beneficiario_nome')
            .eq('id', userId)
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, error: 'Usuario nao encontrado.' });
        return res.json({ success: true, dados: data });
    } catch (err) {
        console.error('Erro ao carregar dados bancarios:', err);
        return res.status(500).json({ success: false, error: 'Erro ao carregar dados bancarios.' });
    }
});

app.get('/meus-investimentos/:userId', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId !== sessao.userId) {
        return res.status(403).json({ success: false, error: 'Operacao nao autorizada.' });
    }
    try {
        const { data, error } = await supabase
            .from('investimentos')
            .select('id, user_id, valor_investido_usd, valor_retorno_usd, data_fim, created_at')
            .eq('user_id', userId)
            .order('data_fim', { ascending: false });
        if (error) throw error;
        const agora = Date.now();
        return res.json((data || []).map((item) => ({
            ...item,
            dias_restantes: Math.ceil((new Date(item.data_fim).getTime() - agora) / 86400000)
        })));
    } catch (err) {
        console.error('Erro ao listar investimentos:', err);
        return res.status(500).json({ success: false, error: 'Erro ao buscar investimentos.' });
    }
});

app.get('/levantamentos/:userId', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId !== sessao.userId) {
        return res.status(403).json({ success: false, error: 'Operacao nao autorizada.' });
    }
    try {
        const { data, error } = await supabase
            .from('levantamentos')
            .select('*')
            .eq('user_id', userId)
            .order('data_solicitacao', { ascending: false });
        if (error) throw error;
        return res.json(data || []);
    } catch (err) {
        console.error('Erro ao listar levantamentos:', err);
        return res.status(500).json({ success: false, error: 'Erro ao buscar levantamentos.' });
    }
});

app.post('/investir', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const valor = Number(String(req.body.valor ?? '').replace(',', '.'));
    const dias = Number(req.body.dias);
    const taxa = Number(req.body.taxa);
    const planos = { 7: 0.20, 30: 0.70, 90: 2.00 };

    if (!Number.isFinite(valor) || valor < VALOR_MINIMO_INVESTIMENTO || !Number.isInteger(dias) || !Object.prototype.hasOwnProperty.call(planos, dias) || Math.abs(taxa - planos[dias]) > 0.0001) {
        return res.status(400).json({ success: false, error: 'Dados ou plano de investimento invalidos.' });
    }
    if (bloquearPedidoDuplicado(req, res, 'investimento', sessao.userId)) return;

    try {
        const resultado = await chamarRpc('investir_v2', {
            p_user_id: sessao.userId,
            p_valor: arredondar2(valor),
            p_dias: dias,
            p_taxa: planos[dias],
            p_request_id: String(req.get('x-request-id') || req.body.requestId)
        });
        if (!resultado || resultado.success !== true) {
            return res.status(400).json({ success: false, error: resultado?.error || 'Nao foi possivel investir.' });
        }
        notificarSaldoUsuario(resultado.telefone, { novoSaldo: resultado.novoSaldo, mensagem: 'Novo investimento aplicado com sucesso.' });
        io.emit('atualizar-investimentos', { userId: sessao.userId, acao: 'criado' });
        return res.json(resultado);
    } catch (err) {
        console.error('Erro ao investir:', err);
        return res.status(500).json({ success: false, error: 'Operacao de investimento indisponivel.' });
    }
});

app.post('/resgatar-investimento', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const investmentId = Number(req.body.investmentId);
    if (!Number.isInteger(investmentId) || investmentId <= 0) {
        return res.status(400).json({ success: false, error: 'Investimento invalido.' });
    }
    if (bloquearPedidoDuplicado(req, res, `resgate:${investmentId}`, sessao.userId)) return;

    try {
        const { data: investimentoAtual, error: investimentoError } = await supabase
            .from('investimentos')
            .select('id, data_fim')
            .eq('id', investmentId)
            .eq('user_id', sessao.userId)
            .maybeSingle();
        if (investimentoError) throw investimentoError;
        if (!investimentoAtual) return res.status(404).json({ success: false, error: 'Investimento nao encontrado ou ja resgatado.' });
        if (new Date(investimentoAtual.data_fim).getTime() > Date.now()) {
            return res.status(400).json({ success: false, vencido: false, dataFim: investimentoAtual.data_fim, error: 'Prazo ainda nao venceu.' });
        }

        const resultado = await chamarRpc('resgatar_investimento_v2', {
            p_user_id: sessao.userId,
            p_investment_id: investmentId
        });
        if (!resultado || resultado.success !== true) {
            return res.status(400).json(resultado || { success: false, error: 'Nao foi possivel resgatar o investimento.' });
        }
        notificarSaldoUsuario(resultado.telefone, { novoSaldo: resultado.novoSaldo, mensagem: 'Investimento resgatado com sucesso.' });
        io.emit('atualizar-investimentos', { userId: sessao.userId, investmentId, acao: 'resgatado' });
        return res.json(resultado);
    } catch (err) {
        console.error('Erro ao resgatar investimento:', err);
        return res.status(500).json({ success: false, error: 'Operacao de resgate indisponivel.' });
    }
});

app.post('/transferir', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const destinoTelefone = assinaturaTelefone(req.body.destinoTelefone);
    const valor = Number(String(req.body.valor ?? '').replace(',', '.'));
    if (!/^9\d{8}$/.test(destinoTelefone) || !Number.isFinite(valor) || valor < VALOR_MINIMO_TRANSFERENCIA) {
        return res.status(400).json({ success: false, error: `A transferencia minima e ${VALOR_MINIMO_TRANSFERENCIA.toFixed(2)} KZ.` });
    }
    if (destinoTelefone === assinaturaTelefone(req.body.remetenteTelefone)) {
        return res.status(400).json({ success: false, error: 'Nao pode transferir para a propria conta.' });
    }
    if (bloquearPedidoDuplicado(req, res, 'transferencia', sessao.userId)) return;

    try {
        const resultado = await chamarRpc('transferir_saldo_v2', {
            p_remetente_id: sessao.userId,
            p_destino_telefone: destinoTelefone,
            p_valor: arredondar2(valor),
            p_request_id: String(req.get('x-request-id') || req.body.requestId)
        });
        if (!resultado || resultado.success !== true) {
            return res.status(400).json({ success: false, error: resultado?.error || 'Nao foi possivel transferir.' });
        }
        notificarSaldoUsuario(resultado.destinoTelefone, { novoSaldo: resultado.saldoDestino, mensagem: `Recebeu ${arredondar2(valor).toFixed(2)} KZ.` });
        notificarSaldoUsuario(resultado.remetenteTelefone, { novoSaldo: resultado.novoSaldo, mensagem: `Transferencia de ${arredondar2(valor).toFixed(2)} KZ realizada.` });
        return res.json({ success: true, novoSaldo: resultado.novoSaldo });
    } catch (err) {
        console.error('Erro ao transferir:', err);
        return res.status(500).json({ success: false, error: 'Operacao de transferencia indisponivel.' });
    }
});

// --- ROTAS OTP CORRIGIDAS ---
async function solicitarOTPCadastro(req, res) {
    const { nome, telefone, senha, indicado_por } = req.body;
    const validacao = validarDadosCadastro({ nome, telefone, senha });
    if (validacao.error) return res.status(400).json({ success: false, error: validacao.error });
    const { nomeLimpo, telefoneAssinatura, senhaLimpa } = validacao;
    try {
        const existente = await buscarUsuarioPorTelefone(telefoneAssinatura, 'id');
        if (existente) return res.status(400).json({ success: false, error: 'Este numero ja esta registado.' });

        const erroLimiteIP = limitarPedidosOTP(req);
        if (erroLimiteIP) return res.status(429).json({ success: false, error: erroLimiteIP });

        const anterior = otpStore.get(telefoneAssinatura);
        if (anterior) {
            if (anterior.expira <= Date.now()) {
                otpStore.delete(telefoneAssinatura);
            } else if (Date.now() - anterior.enviadoEm < OTP_REENVIO_MS) {
                const segundos = Math.ceil((OTP_REENVIO_MS - (Date.now() - anterior.enviadoEm)) / 1000);
                return res.status(429).json({ success: false, error: `Aguarde ${segundos}s para reenviar o codigo.` });
            }
        }

        // A API de referência gera e devolve o OTP. O código fica apenas na memória do servidor.
        const codigo = await enviarOTPCadastro(telefoneAssinatura);
        otpStore.set(telefoneAssinatura, {
            codigo,
            nome: nomeLimpo,
            senha: senhaLimpa,
            indicado_por: indicado_por || null,
            expira: Date.now() + OTP_EXPIRA_MS,
            enviadoEm: Date.now(),
            tentativas: 0,
        });
        res.json({ success: true, telefone: telefoneAssinatura, expiraEmSegundos: Math.floor(OTP_EXPIRA_MS / 1000), mensagem: 'Codigo de confirmacao enviado por SMS.' });
    } catch (err) {
        console.error('Erro ao solicitar OTP:', err);
        res.status(500).json({ success: false, error: err.message || 'Erro ao enviar o codigo.' });
    }
}
app.post('/auth/solicitar-otp-cadastro', solicitarOTPCadastro);
app.post('/auth/cadastro', solicitarOTPCadastro);

app.post('/auth/confirmar-cadastro', async (req, res) => {
    const telefoneAssinatura = assinaturaTelefone(req.body.telefone);
    const codigo = String(req.body.codigo || '').replace(/\D/g, '');
    if (!/^9\d{8}$/.test(telefoneAssinatura) || !/^\d{4,8}$/.test(codigo)) {
        return res.status(400).json({ success: false, error: 'Telefone ou codigo invalido.' });
    }

    try {
        const pendente = otpStore.get(telefoneAssinatura);
        if (!pendente) return res.status(400).json({ success: false, error: 'Solicite um novo codigo de confirmacao.' });

        const agora = Date.now();
        if (pendente.expira <= agora) {
            otpStore.delete(telefoneAssinatura);
            return res.status(400).json({ success: false, error: 'Codigo expirado. Solicite um novo codigo.' });
        }
        if ((pendente.tentativas || 0) >= OTP_MAX_TENTATIVAS) {
            otpStore.delete(telefoneAssinatura);
            return res.status(429).json({ success: false, error: 'Limite de tentativas excedido.' });
        }
        if (String(pendente.codigo)!== codigo) {
            pendente.tentativas = (pendente.tentativas || 0) + 1;
            if (pendente.tentativas >= OTP_MAX_TENTATIVAS) otpStore.delete(telefoneAssinatura);
            return res.status(401).json({ success: false, error: 'Codigo de confirmacao incorreto.' });
        }

        const existente = await buscarUsuarioPorTelefone(telefoneAssinatura, 'id');
        if (existente) {
            otpStore.delete(telefoneAssinatura);
            return res.status(400).json({ success: false, error: 'Este numero ja esta registado.' });
        }

        const payload = { nome_completo: pendente.nome, telefone: telefoneAssinatura, senha: pendente.senha, saldo_usd: 50.00 };
        const indicadoPorNum = parseInt(pendente.indicado_por);
        if (Number.isInteger(indicadoPorNum) && indicadoPorNum > 0) payload.indicado_por = indicadoPorNum;

        const { data, error: insertErr } = await supabase.from('usuarios').insert(payload).select('id, nome_completo, telefone, saldo_usd').single();
        if (insertErr) throw insertErr;

        otpStore.delete(telefoneAssinatura);
        res.status(201).json({ success: true, usuario: data });
    } catch (err) {
        console.error('Erro ao confirmar cadastro:', err);
        res.status(500).json({ success: false, error: 'Erro ao criar a conta.' });
    }
});

// --- DEPOSITOS (COMPROVATIVOS) ---
// A data do comprovativo nao e validada: comprovativos de qualquer dia sao aceites
// quando a API confirma a transferencia, o destino e o valor.
app.post('/depositos/validar', depositoUpload.single('comprovativo'), async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum comprovativo enviado.' });
    if (!DEPOSITO_API_KEY) return res.status(500).json({ success: false, error: 'Chave de deposito nao configurada.' });

    const formData = new FormData();
    formData.append('fasmapay_appkey', DEPOSITO_API_KEY);
    formData.append('recibo', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    const controller = global.AbortController ? new global.AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), DEPOSITO_TIMEOUT_MS) : null;
    let response;
    try {
        response = await fetch(DEPOSITO_SUDO_URL, {
            method: 'POST', body: formData, headers: formData.getHeaders(),
            signal: controller ? controller.signal : undefined,
        });
    } catch (error) {
        if (error?.name === 'AbortError') return res.status(504).json({ success: false, error: 'Tempo limite ao validar comprovativo.' });
        return res.status(502).json({ success: false, error: 'Erro ao comunicar com a API de validacao.' });
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    const respostaTexto = await response.text();
    let data = {};
    try { data = respostaTexto ? JSON.parse(respostaTexto) : {}; } catch { data = { raw: respostaTexto }; }
    if (!response.ok) return res.status(response.status).json({ success: false, error: 'Erro na API de validacao.', data });

    const statusValido = data.STATUS === 200 || data.status === 200 || data.sucesso === true || data.success === true;
    if (!statusValido) return res.status(400).json({ success: false, error: 'Comprovativo invalido ou nao confirmado.', data });

    const destino = validarDestinoComprovativo(JSON.stringify(data));
    if (!destino.ok) return res.status(400).json({ success: false, error: 'Comprovativo nao corresponde ao destino configurado.' });
    const transferenciaId = extrairTransferenciaId(data, JSON.stringify(data));
    const valorKz = extrairValorComprovativo(data, JSON.stringify(data));
    if (!transferenciaId) return res.status(400).json({ success: false, error: 'Nao foi possivel identificar o ID da transferencia.' });
    if (!Number.isFinite(valorKz) || valorKz <= 0) return res.status(400).json({ success: false, error: 'Valor invalido no comprovativo.' });

    try {
        const resultado = await chamarRpc('depositar_comprovativo_v2', {
            p_user_id: sessao.userId,
            p_transferencia_id: transferenciaId,
            p_valor_kz: arredondar2(valorKz),
            p_destino_tipo: destino.tipo,
            p_destino_valor: destino.valor,
            p_detalhes: data,
        });
        if (!resultado?.success) return res.status(400).json({ success: false, error: resultado?.error || 'Comprovativo ja utilizado ou deposito recusado.' });
        notificarSaldoUsuario(resultado.telefone, { novoSaldo: resultado.novoSaldo, mensagem: `Deposito confirmado: ${arredondar2(valorKz).toFixed(2)} KZ adicionados.` });
        io.emit('atualizar-historico', { userId: sessao.userId });
        return res.json({ success: true, novoSaldo: resultado.novoSaldo, valorKz: arredondar2(valorKz), transferenciaId });
    } catch (error) {
        console.error('Erro ao registar deposito:', error);
        return res.status(503).json({ success: false, error: 'Deposito indisponivel. A operacao nao foi creditada.' });
    }
});

// --- ALTERACAO DE PALAVRA-PASSE ---
app.post('/auth/alterar-senha', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const senhaAtual = String(req.body.senhaAtual || '');
    const novaSenha = String(req.body.novaSenha || '').trim();
    if (!senhaAtual || novaSenha.length < 5) return res.status(400).json({ success: false, error: 'Dados de senha invalidos.' });
    try {
        const { data: user, error: fetchError } = await supabase.from('usuarios').select('id, senha').eq('id', sessao.userId).single();
        if (fetchError || !user) return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        if (String(user.senha) !== senhaAtual) return res.status(401).json({ success: false, error: 'A senha atual esta incorreta.' });
        const { error } = await supabase.from('usuarios').update({ senha: novaSenha }).eq('id', sessao.userId);
        if (error) throw error;
        res.json({ success: true, mensagem: 'Senha alterada com sucesso.' });
    } catch (error) { res.status(500).json({ success: false, error: 'Erro interno ao alterar senha.' }); }
});

// --- SUPORTE ---
app.get('/config/suporte', async (req, res) => {
    try {
        const { data, error } = await supabase.from('suporte_config').select('mensagem, ativo').eq('id', 1).single();
        if (error || !data) return res.json({ mensagem: '', ativo: false });
        res.json({ mensagem: data.mensagem || '', ativo: !!data.ativo });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- HISTORICO ---
app.get('/historico/:userId', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const userId = Number(req.params.userId);
    if (userId !== sessao.userId) return res.status(403).json({ success: false, error: 'Acesso nao autorizado.' });
    try {
        const [{ data: transacoes, error: txError }, { data: levantamentos, error: levError }, { data: excluidos, error: excError }] = await Promise.all([
            supabase.from('transacoes').select('*').or(`remetente_id.eq.${userId},destinatario_id.eq.${userId}`).order('data', { ascending: false }),
            supabase.from('levantamentos').select('*').eq('user_id', userId).order('data_solicitacao', { ascending: false }),
            supabase.from('historico_excluido').select('registro_tipo, registro_id').eq('user_id', userId),
        ]);
        if (txError || levError || excError) throw txError || levError || excError;
        const excluidosSet = new Set((excluidos || []).map((r) => `${r.registro_tipo}-${Number(r.registro_id)}`));
        const itens = (transacoes || []).filter((tx) => !excluidosSet.has(`transacao-${Number(tx.id)}`)).map((tx) => {
            const tipo = tipoTransacao(tx, userId);
            return { id: tx.id, titulo: tituloTransacao(tx, userId, tipo), tipo, valor: toNumberSafe(tx.valor), data: tx.data, icon: '📝', nome: tx.remetente_nome };
        });
        for (const lev of (levantamentos || [])) {
            if (excluidosSet.has(`levantamento-${Number(lev.id)}`)) continue;
            const valor = Math.abs(toNumberSafe(lev.valor));
            const status = String(lev.status || 'pendente').toLowerCase();
            itens.push({ id: `levantamento-${lev.id}`, titulo: status === 'pago' ? 'Levantamento pago' : status === 'rejeitado' ? 'Levantamento rejeitado (valor devolvido)' : 'Levantamento pendente', tipo: status === 'pago' ? 'levantamento_pago' : status === 'rejeitado' ? 'levantamento_rejeitado' : 'levantamento_pendente', valor: status === 'rejeitado' ? valor : -valor, data: lev.data_resposta || lev.data_solicitacao, icon: status === 'pago' ? '✅' : status === 'rejeitado' ? '↩️' : '🏦', nome: 'Levantamento', status });
        }
        itens.sort((a, b) => new Date(b.data) - new Date(a.data));
        res.json(itens);
    } catch (error) { res.status(500).json({ error: 'Erro ao buscar historico.' }); }
});

app.post('/historico/eliminar', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const registroId = String(req.body.registroId || '');
    const [tipo, idTexto] = registroId.split('-');
    const id = Number(idTexto);
    if (!['transacao', 'levantamento'].includes(tipo) || !Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: 'Registro de historico invalido.' });
    try {
        if (tipo === 'transacao') {
            const { data, error } = await supabase.from('transacoes').select('id').eq('id', id).or(`remetente_id.eq.${sessao.userId},destinatario_id.eq.${sessao.userId}`).maybeSingle();
            if (error || !data) return res.status(404).json({ success: false, error: 'Registro nao encontrado.' });
        } else {
            const { data, error } = await supabase.from('levantamentos').select('id').eq('id', id).eq('user_id', sessao.userId).maybeSingle();
            if (error || !data) return res.status(404).json({ success: false, error: 'Registro nao encontrado.' });
        }
        const { error } = await supabase.from('historico_excluido').upsert({ user_id: sessao.userId, registro_tipo: tipo, registro_id: id }, { onConflict: 'user_id, registro_tipo, registro_id' });
        if (error) throw error;
        io.emit('atualizar-historico', { userId: sessao.userId, registroTipo: tipo, registroId: id });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- CONVITES ---
app.get('/referrals/stats/:userId', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const userId = Number(req.params.userId);
    if (userId !== sessao.userId) return res.status(403).json({ success: false, error: 'Acesso nao autorizado.' });
    try {
        const [{ count, error: countError }, { data: bonus, error: bonusError }] = await Promise.all([
            supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('indicado_por', userId),
            supabase.from('transacoes').select('valor').eq('destinatario_id', userId).ilike('remetente_nome', '%Bônus de Convite%').eq('vinculado', false),
        ]);
        if (countError || bonusError) throw countError || bonusError;
        res.json({ totalInvited: count || 0, totalBonus: arredondar2((bonus || []).reduce((total, tx) => total + toNumberSafe(tx.valor), 0)) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/referrals/vincular', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    if (bloquearPedidoDuplicado(req, res, 'bonus', sessao.userId)) return;
    try {
        const resultado = await chamarRpc('vincular_bonus_v2', { p_user_id: sessao.userId });
        if (!resultado?.success) return res.status(400).json({ success: false, error: resultado?.error || 'Nao ha bonus acumulados para vincular.' });
        notificarSaldoUsuario(resultado.telefone, { novoSaldo: resultado.novoSaldo, mensagem: `Bonus de ${resultado.valorVinculado.toFixed(2)} KZ vinculado ao seu saldo.` });
        res.json(resultado);
    } catch (error) { res.status(503).json({ success: false, error: 'Nao foi possivel vincular o bonus.' }); }
});

// --- ROTAS ADMINISTRATIVAS EM FALTA ---
app.get('/admin/levantamentos', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data, error } = await supabase.from('levantamentos').select('*').order('data_solicitacao', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/levantamentos/:id/aprovar', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data, error } = await supabase.from('levantamentos').update({ status: 'pago', data_resposta: new Date().toISOString(), respondido_por: 'admin' }).eq('id', req.params.id).eq('status', 'pendente').select('*').maybeSingle();
        if (error || !data) return res.status(400).json({ success: false, error: 'Levantamento invalido ou ja processado.' });
        const { data: user } = await supabase.from('usuarios').select('saldo_usd').eq('id', data.user_id).single();
        notificarSaldoUsuario(data.user_telefone, { novoSaldo: toNumberSafe(user?.saldo_usd), mensagem: `Seu levantamento de ${toNumberSafe(data.valor).toFixed(2)} KZ foi pago.` });
        io.emit('atualizar-levantamentos', { userId: Number(data.user_id), levantamentoId: Number(data.id), status: 'pago' });
        res.json({ success: true, mensagem: 'Levantamento aprovado com sucesso.' });
    } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

app.post('/admin/levantamentos/:id/rejeitar', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data: lev, error: levError } = await supabase.from('levantamentos').select('*').eq('id', req.params.id).eq('status', 'pendente').maybeSingle();
        if (levError || !lev) return res.status(400).json({ success: false, error: 'Levantamento invalido ou ja processado.' });
        const { data: user, error: userError } = await supabase.from('usuarios').select('saldo_usd, telefone').eq('id', lev.user_id).single();
        if (userError || !user) throw userError || new Error('Utilizador nao encontrado.');
        const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + toNumberSafe(lev.valor));
        const { error: saldoError } = await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', lev.user_id);
        if (saldoError) throw saldoError;
        const { data: atualizado, error: statusError } = await supabase.from('levantamentos').update({ status: 'rejeitado', motivo_rejeicao: String(req.body.motivo || '').trim() || null, data_resposta: new Date().toISOString(), respondido_por: 'admin' }).eq('id', lev.id).eq('status', 'pendente').select('id').maybeSingle();
        if (statusError || !atualizado) return res.status(409).json({ success: false, error: 'Levantamento ja processado.' });
        notificarSaldoUsuario(user.telefone, { novoSaldo, mensagem: `Seu levantamento de ${toNumberSafe(lev.valor).toFixed(2)} KZ foi rejeitado. O valor voltou para sua conta.` });
        io.emit('atualizar-levantamentos', { userId: Number(lev.user_id), levantamentoId: Number(lev.id), status: 'rejeitado' });
        res.json({ success: true, mensagem: 'Levantamento rejeitado e saldo devolvido.' });
    } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

app.post('/admin/levantamentos/:id/eliminar', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data, error } = await supabase.from('levantamentos').delete().eq('id', req.params.id).select('user_id').maybeSingle();
        if (error || !data) return res.status(404).json({ success: false, error: 'Levantamento nao encontrado.' });
        io.emit('atualizar-levantamentos', { userId: Number(data.user_id), levantamentoId: Number(req.params.id), status: 'eliminado' });
        res.json({ success: true, mensagem: 'Registo eliminado com sucesso.' });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/admin/investimentos-usuario/:userId', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const [{ data: usuario, error: userError }, { data: investimentos, error: invError }] = await Promise.all([
            supabase.from('usuarios').select('id, nome_completo, telefone, saldo_usd').eq('id', req.params.userId).single(),
            supabase.from('investimentos').select('*').eq('user_id', req.params.userId).order('data_fim', { ascending: false }),
        ]);
        if (userError || invError) throw userError || invError;
        const agora = Date.now();
        res.json({ success: true, usuario, investimentos: (investimentos || []).map((inv) => ({ ...inv, dias_restantes: Math.max(0, Math.ceil((new Date(inv.data_fim).getTime() - agora) / 86400000)) })) });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/admin/total-plataforma', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data, error } = await supabase.from('usuarios').select('saldo_usd');
        if (error) throw error;
        res.json({ total: arredondar2((data || []).reduce((total, user) => total + toNumberSafe(user.saldo_usd), 0)) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/total-usuarios', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { count, error } = await supabase.from('usuarios').select('*', { count: 'exact', head: true });
        if (error) throw error;
        res.json({ total: count || 0 });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/listar-usuarios', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data, error } = await supabase.from('usuarios').select('id, nome_completo, telefone, saldo_usd').order('id', { ascending: false }).limit(500);
        if (error) throw error;
        res.json(data || []);
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/admin/usuario-mais-rico', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data, error } = await supabase.from('usuarios').select('*').order('saldo_usd', { ascending: false }).limit(1).maybeSingle();
        if (error || !data) return res.status(404).json({ success: false, error: 'Nenhum utilizador encontrado.' });
        res.json(data);
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/alterar-nome', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const nome = String(req.body.novoNome || '').trim();
    if (nome.length < 3) return res.status(400).json({ success: false, error: 'Nome invalido.' });
    try {
        const { data, error } = await supabase.from('usuarios').update({ nome_completo: nome }).eq('id', req.body.userId).select('nome_completo').maybeSingle();
        if (error || !data) return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        res.json({ success: true, nome: data.nome_completo });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/alterar-senha', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const senha = String(req.body.novaSenha || '').trim();
    if (senha.length < 5) return res.status(400).json({ success: false, error: 'Nova senha invalida.' });
    try {
        const { data, error } = await supabase.from('usuarios').update({ senha }).eq('id', req.body.userId).select('id').maybeSingle();
        if (error || !data) return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/alterar-dados-bancarios', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const unitel = String(req.body.unitel_money || '').replace(/\D/g, '');
    const iban = normalizarIban(req.body.iban);
    const nome = String(req.body.beneficiario_nome || '').trim();
    if (unitel && !/^9\d{8}$/.test(unitel)) return res.status(400).json({ success: false, error: 'Numero Unitel Money invalido.' });
    if (iban && !/^\d{21}$/.test(iban)) return res.status(400).json({ success: false, error: 'IBAN invalido.' });
    if (iban && nome.length < 3) return res.status(400).json({ success: false, error: 'Nome do beneficiario invalido.' });
    if (!unitel && !iban) return res.status(400).json({ success: false, error: 'Informe o Unitel Money ou o IBAN.' });
    try {
        const update = unitel ? { unitel_money: unitel } : { iban, beneficiario_nome: nome };
        const { data, error } = await supabase.from('usuarios').update(update).eq('id', req.body.userId).select().maybeSingle();
        if (error || !data) return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        io.emit('atualizar-dados-bancarios', { userId: Number(req.body.userId) });
        res.json({ success: true, dados: data });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/limpar-dados-bancarios', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    try {
        const { data, error } = await supabase.from('usuarios').update({ unitel_money: null, iban: null, beneficiario_nome: null }).eq('id', req.body.userId).select().maybeSingle();
        if (error || !data) return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        io.emit('atualizar-dados-bancarios', { userId: Number(req.body.userId) });
        res.json({ success: true, dados: data });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/config/suporte', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const mensagem = String(req.body.mensagem || '').trim();
    const ativo = !!req.body.ativo;
    try {
        const { error } = await supabase.from('suporte_config').update({ mensagem, ativo, atualizado_em: new Date().toISOString() }).eq('id', 1);
        if (error) throw error;
        io.emit('atualizar-suporte', { ativo, mensagem });
        res.json({ success: true, ativo, mensagem });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/ajustar-saldo', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const valor = toNumberSafe(req.body.valor, NaN);
    const operacao = String(req.body.operacao || '').toLowerCase();
    if (!Number.isFinite(valor) || valor <= 0 || !['soma', 'subtracao'].includes(operacao)) return res.status(400).json({ success: false, error: 'Ajuste de saldo invalido.' });
    try {
        const { data: user, error: fetchError } = await supabase.from('usuarios').select('id, nome_completo, saldo_usd, telefone').eq('id', req.body.userId).single();
        if (fetchError || !user) return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        const saldo = toNumberSafe(user.saldo_usd);
        if (operacao === 'subtracao' && saldo < valor) return res.status(400).json({ success: false, error: 'Saldo insuficiente.' });
        const novoSaldo = arredondar2(operacao === 'soma' ? saldo + valor : saldo - valor);
        const { error: updateError } = await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', user.id);
        if (updateError) throw updateError;
        const { error: txError } = await supabase.from('transacoes').insert({ remetente_id: null, remetente_nome: operacao === 'soma' ? 'Deposito pelo Suporte' : 'Ajuste de Saldo (Debito)', destinatario_id: user.id, destinatario_nome: user.nome_completo, valor: operacao === 'soma' ? valor : -valor });
        if (txError) throw txError;
        notificarSaldoUsuario(user.telefone, { novoSaldo, mensagem: `Administrador ${operacao === 'soma' ? 'adicionou' : 'removeu'} ${valor.toFixed(2)} KZ na sua conta.` });
        res.json({ success: true, novoSaldo });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/bonus-global', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const valor = toNumberSafe(req.body.valor, NaN);
    if (!Number.isFinite(valor) || valor <= 0) return res.status(400).json({ success: false, error: 'Valor de bonus invalido.' });
    try {
        const { data: usuarios, error } = await supabase.from('usuarios').select('id, saldo_usd, telefone');
        if (error) throw error;
        for (const user of usuarios || []) {
            const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + valor);
            const { error: updateError } = await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', user.id);
            if (updateError) throw updateError;
            notificarSaldoUsuario(user.telefone, { novoSaldo, mensagem: `Voce recebeu um bonus de ${valor.toFixed(2)} KZ.` });
        }
        res.json({ success: true, usuariosAtualizados: (usuarios || []).length });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/depositos/bloquear', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const transferenciaId = String(req.body.transferenciaId || '').trim();
    if (!transferenciaId) return res.status(400).json({ success: false, error: 'ID da transferencia obrigatorio.' });
    try {
        const { data: existe } = await supabase.from('comprovativos_bloqueados').select('id').eq('transferencia_id', transferenciaId).maybeSingle();
        if (existe) return res.status(400).json({ success: false, error: 'Ja bloqueado.' });
        const { error } = await supabase.from('comprovativos_bloqueados').insert({ transferencia_id: transferenciaId, motivo: String(req.body.motivo || 'Sem motivo'), criado_por: 'admin' });
        if (error) throw error;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/eliminar-usuario', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ success: false, error: 'Utilizador invalido.' });
    try {
        for (const tabela of ['investimentos', 'levantamentos', 'transacoes', 'historico_excluido', 'depositos']) {
            const { error } = await supabase.from(tabela).delete().eq(tabela === 'transacoes' ? 'remetente_id' : tabela === 'historico_excluido' ? 'user_id' : 'user_id', userId);
            if (error && !/does not exist|relation/i.test(error.message || '')) throw error;
        }
        const { error } = await supabase.from('usuarios').delete().eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/investimentos/:id/cancelar', async (req, res) => {
    if (!exigirAdmin(req, res)) return;
    const investimentoId = Number(req.params.id);
    if (!Number.isInteger(investimentoId) || investimentoId <= 0) return res.status(400).json({ success: false, error: 'Investimento invalido.' });
    try {
        const { data: inv, error: invError } = await supabase.from('investimentos').select('id, user_id, valor_investido_usd, usuarios(telefone, saldo_usd)').eq('id', investimentoId).single();
        if (invError || !inv) return res.status(404).json({ success: false, error: 'Investimento nao encontrado.' });
        const valor = toNumberSafe(inv.valor_investido_usd);
        const novoSaldo = arredondar2(toNumberSafe(inv.usuarios?.saldo_usd) + valor);
        const { error: saldoError } = await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', inv.user_id);
        if (saldoError) throw saldoError;
        const { error: txError } = await supabase.from('transacoes').insert({ remetente_id: inv.user_id, remetente_nome: 'Cancelamento de investimento', destinatario_id: inv.user_id, destinatario_nome: 'Cancelamento de investimento', valor });
        if (txError) throw txError;
        const { error: deleteError } = await supabase.from('investimentos').delete().eq('id', investimentoId);
        if (deleteError) throw deleteError;
        notificarSaldoUsuario(inv.usuarios?.telefone, { novoSaldo, mensagem: `Investimento cancelado pelo administrador. ${valor.toFixed(2)} KZ devolvido.` });
        io.emit('atualizar-investimentos', { userId: Number(inv.user_id), investmentId: investimentoId, acao: 'cancelado_admin' });
        res.json({ success: true, userId: Number(inv.user_id), novoSaldo, valorDevolvido: valor });
    } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

// Tratamento dos erros de upload do comprovativo.
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: `Arquivo excede ${DEPOSITO_MAX_FILE_MB}MB.` });
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err?.message === 'Tipo de arquivo nao suportado. Envie PDF ou imagem.') return res.status(400).json({ success: false, error: err.message });
    if (err) {
        console.error('Erro no servidor:', err);
        return res.status(500).json({ success: false, error: 'Erro ao processar comprovativo.' });
    }
    next();
});

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, '0.0.0.0', () => {
    console.log(`🚀 API RICO INVESTIMENTO ativa na porta ${PORTA}`);
});
