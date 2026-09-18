﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
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

// Servir arquivos estáticos da pasta 'site'
app.use(express.static(path.join(__dirname, 'site')));

// CONFIGURAÇÃO SUPABASE (Credenciais do RICO INVESTIMENTO)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgwxtbxgxozxicmipadr.supabase.co';
// As RPCs financeiras podem estar restritas ao service_role.
// Configure SUPABASE_SERVICE_ROLE_KEY localmente/ no Render; nunca coloque-a no HTML.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || 'sb_publishable_cAFfrLoGx4MbG0J3IXwINw_f6NOuPkQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CONFIGURACOES DE DEPOSITO
const DEPOSITO_API_KEY = process.env.DEPOSITO_API_KEY || '32y3103KsiiaoL57dt38blJ1TWKxeDrUYucBeraKgI47hr2RbsJBOsJEtScy590203';
const DEPOSITO_DESTINO_NUMERO = '926240472';
const DEPOSITO_DESTINO_IBAN = '';
const DEPOSITO_TAXA_KZ = 1;
const DEPOSITO_SUDO_URL = 'https://comprovativos.sudomakes.com/validar/';
const DEPOSITO_MAX_FILE_MB = 10;
const DEPOSITO_TIMEOUT_MS = 25000;

const SMS_API_URL = 'https://smsapi.sudomakes.com/api/enviar-sms';
const SMS_API_KEY = process.env.SMS_API_KEY || 'hEc65zq9ipXOJeprFj4zMeW+OCiWAWohyoqSPeBqJX17ZD4Xgw8UGQiG5I5Dcs4G';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123';
const KASSALA_API_KEY = process.env.KASSALA_API_KEY || 'VFlkCkvV+LdsirzvfB4J6/rGl6eMItrUQYR3/HsVRb42yBJAM+p3urmKwDdsF0l3duva/fyFWvkjIumDcE/uagO53vdAj74CuXiNZOVMkwc=';
const OTP_EXPIRA_MS = 5 * 60 * 1000;
const OTP_REENVIO_MS = 60 * 1000;
const OTP_MAX_TENTATIVAS = 5;
const OTP_IP_WINDOW_MS = 10 * 60 * 1000;
const OTP_IP_MAX_REQUESTS = 10;
const otpStore = new Map();
const otpIpStore = new Map();
const sessoes = new Map();
const levantamentosEmProcessamento = new Set();
const SESSAO_EXPIRA_MS = 7 * 24 * 60 * 60 * 1000;

const otpCleanupTimer = setInterval(() => {
    const agora = Date.now();
    for (const [telefone, registro] of otpStore.entries()) {
        if (!registro || registro.expira <= agora) otpStore.delete(telefone);
    }
}, 60 * 1000);
otpCleanupTimer.unref?.();

function toNumberSafe(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function arredondar2(value) {
    return Number(toNumberSafe(value).toFixed(2));
}

function criarSessao(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessoes.set(token, { userId: Number(userId), expira: Date.now() + SESSAO_EXPIRA_MS });
    return token;
}

function obterSessao(req) {
    const authorization = String(req.get('authorization') || '');
    const token = authorization.startsWith('Bearer ')
        ? authorization.slice(7).trim()
        : String(req.get('x-session-token') || '').trim();
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

function formatarNumeroSMS(destinatario) {
    const numero = String(destinatario || '').replace(/\D/g, '');
    if (!numero) return '';
    return numero.startsWith('244') ? `+${numero}` : `+244${numero}`;
}

async function enviarSMS(destinatario, mensagem) {
    if (!SMS_API_KEY) return null;
    const numeroFormatado = formatarNumeroSMS(destinatario);
    if (!numeroFormatado) return null;

    try {
        const response = await fetch(SMS_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                api_key: SMS_API_KEY,
                destinatario: numeroFormatado,
                mensagem
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error('Erro SMS:', data);
        }
        return data;
    } catch (error) {
        console.error('Erro SMS:', error.message);
        return null;
    }
}

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
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
            timeout: 15000
        }, (resposta) => {
            let texto = '';
            resposta.setEncoding('utf8');
            resposta.on('data', (parte) => { texto += parte; });
            resposta.on('end', () => {
                try { resolve(texto ? JSON.parse(texto) : {}); }
                catch { resolve({ status: -1, log: texto }); }
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
    if (registro.total >= OTP_IP_MAX_REQUESTS) return 'Muitos pedidos de SMS. Tente novamente mais tarde.';
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
        throw new Error(String(resposta.log || resposta.erro || resposta.mensagem || 'Falha ao enviar codigo OTP.'));
    }
    return String(resposta.otp);
}
const depositoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: DEPOSITO_MAX_FILE_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const isPdf = file.mimetype === 'application/pdf';
        const isImage = file.mimetype.startsWith('image/');

        if (!isPdf && !isImage) {
            return cb(new Error('Tipo de arquivo nao suportado. Envie PDF ou imagem.'));
        }

        return cb(null, true);
    },
});

// MAPA PARA GUARDAR USUÁRIOS ONLINE
const usuariosOnline = new Map(); // Usado para gerenciar sockets de usuários online

io.on('connection', (socket) => {
    socket.on('registrar-online', (telefone) => {
        usuariosOnline.set(String(telefone), socket.id);
        console.log(`рџ“± UsuГЎrio ${telefone} estГЎ online.`);
    });

    socket.on('disconnect', () => {
        const key = socket.data.telefoneKey;
        if (key && usuariosOnline.get(key) === socket.id) {
            usuariosOnline.delete(key);
        }
    });
});

function notificarSaldoUsuario(telefone, payload) {
    const key = assinaturaTelefone(telefone);
    if (!key) return;
    const socketDestino = usuariosOnline.get(key);
    if (socketDestino) {
        io.to(socketDestino).emit('atualizar-saldo', payload);
    }
}

function normalizarDigitos(value) {
    return String(value || '').replace(/\D/g, '');
}

function assinaturaTelefone(value) {
    const digitos = normalizarDigitos(value);
    if (!digitos) return '';
    return digitos.length > 9 ? digitos.slice(-9) : digitos;
}

function gerarVariacoesTelefone(value) {
    const assinatura = assinaturaTelefone(value);
    const completo = normalizarDigitos(value);
    if (!assinatura && !completo) return [];
    return [...new Set([
        assinatura,
        `+244${assinatura}`,
        `244${assinatura}`,
        `0${assinatura}`,
        completo,
        `+${completo}`
    ].filter(Boolean))];
}

async function buscarUsuariosPorTelefone(telefone, colunas = '*') {
    const variacoes = gerarVariacoesTelefone(telefone);
    const assinatura = assinaturaTelefone(telefone);
    if (!variacoes.length || !assinatura) return [];

    const { data: porIgualdade, error: erroEq } = await supabase
        .from('usuarios')
        .select(colunas)
        .in('telefone', variacoes);
    if (erroEq) throw erroEq;

    if (porIgualdade && porIgualdade.length > 0) return porIgualdade;

    // Busca mais inteligente usando o fim do número para evitar carregar 1000 registros
    const { data: porAssinatura, error: erroAssinatura } = await supabase
        .from('usuarios')
        .select(colunas)
        .like('telefone', `%${assinatura}`);

    if (erroAssinatura) throw erroAssinatura;
    return porAssinatura || [];
}

async function buscarUsuarioPorTelefone(telefone, colunas = '*') {
    const lista = await buscarUsuariosPorTelefone(telefone, colunas);
    return lista[0] || null;
}

function normalizarTexto(valor) {
    return String(valor || '').trim();
}

function tipoTransacao(tx, userId) {
    const remetenteNome = String(tx.remetente_nome || '').toLowerCase();
    const destinatarioNome = String(tx.destinatario_nome || '').toLowerCase();
    const valor = toNumberSafe(tx.valor);

    // Prioridade para identificação de sistema e suporte
    if (remetenteNome.includes('deposito') || remetenteNome.includes('suporte')) return 'deposito';
    if (remetenteNome.includes('ganho do investimento')) return 'ganho';
    if (remetenteNome.includes('cancelamento de investimento')) return 'cancelamento_investimento';
    if (remetenteNome.includes('bônus')) return 'bonus';
    if (destinatarioNome.includes('investimento') || remetenteNome.includes('investimento')) return 'investimento';

    // Identificação de transferências P2P
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

function normalizarIban(valor) {
    return normalizarTexto(valor).replace(/\s+/g, '').toUpperCase();
}

function obterValorChave(data, chaves) {
    if (!data || typeof data !== 'object') return null;
    const mapa = {};
    Object.keys(data).forEach((k) => {
        mapa[String(k).toUpperCase()] = data[k];
    });
    for (const chave of chaves) {
        const valor = mapa[String(chave).toUpperCase()];
        if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
            return valor;
        }
    }
    return null;
}

function parseValorMonetario(valorRaw) {
    if (valorRaw === undefined || valorRaw === null) return NaN;
    let texto = String(valorRaw).replace(/[^\d,.-]/g, '');
    if (!texto) return NaN;

    const temVirgula = texto.includes(',');
    const temPonto = texto.includes('.');

    if (temVirgula && temPonto) {
        texto = texto.replace(/\./g, '').replace(',', '.');
    } else if (temVirgula && !temPonto) {
        texto = texto.replace(',', '.');
    }

    const numero = parseFloat(texto);
    return Number.isFinite(numero) ? numero : NaN;
}

function extrairTransferenciaId(data, respostaTexto) {
    const id = obterValorChave(data, [
        'ID_TRANSACAO', 'IDTRANSACAO', 'TRANSACAO_ID', 'TRANS_ID',
        'REFERENCIA', 'REF', 'RECIBO', 'NUM_TRANSACAO', 'ID', 'TXID', 'TID'
    ]);
    if (id) return String(id);

    if (respostaTexto) {
        const match = respostaTexto.match(/(ID|REF|TRANSACAO|TRANSAC)[^0-9]*([0-9]{6,})/i);
        if (match && match[2]) {
            return String(match[2]);
        }
        const hash = crypto.createHash('sha256').update(respostaTexto).digest('hex').slice(0, 32);
        return `hash-${hash}`;
    }

    return null;
}

function extrairValorComprovativo(data, respostaTexto) {
    const valor = obterValorChave(data, [
        'MONTANTE', 'VALOR', 'AMOUNT', 'TOTAL', 'QUANTIA', 'VALOR_PAGO', 'VALOR_TOTAL'
    ]);
    let numero = parseValorMonetario(valor);

    if (!Number.isFinite(numero) && respostaTexto) {
        const match = respostaTexto.match(/(\d[\d.,]{2,})\s*(KZ|AOA)/i);
        if (match && match[1]) {
            numero = parseValorMonetario(match[1]);
        }
    }

    return numero;
}

function validarDestinoComprovativo(respostaTexto) {
    if (!respostaTexto) return { ok: false, tipo: null, valor: null };
    const textoBruto = String(respostaTexto);
    const texto = textoBruto.replace(/\s+/g, '').toUpperCase();
    const textoNumeros = textoBruto.replace(/\D/g, '');

    const numeroAlvo = normalizarTexto(DEPOSITO_DESTINO_NUMERO);
    const ibanAlvo = normalizarIban(DEPOSITO_DESTINO_IBAN);

    const numeroOk = numeroAlvo ? textoNumeros.includes(numeroAlvo) : false;
    const ibanOk = ibanAlvo ? texto.includes(ibanAlvo) : false;

    if (numeroOk) return { ok: true, tipo: 'numero', valor: numeroAlvo };
    if (ibanOk) return { ok: true, tipo: 'iban', valor: ibanAlvo };
    return { ok: false, tipo: null, valor: null };
}

// --- DEPOSITOS (COMPROVATIVOS) ---
app.post('/depositos/validar', depositoUpload.single('comprovativo'), async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;
    const userIdNum = sessao.userId;

    if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
        return res.status(400).json({ success: false, error: 'Utilizador invalido.' });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Nenhum comprovativo enviado.' });
    }

    if (!DEPOSITO_API_KEY) {
        return res.status(500).json({ success: false, error: 'Chave de deposito nao configurada.' });
    }

    const formData = new FormData();
    formData.append('fasmapay_appkey', DEPOSITO_API_KEY);
    formData.append('recibo', req.file.buffer, {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
    });

    const Controller = global.AbortController;
    const controller = Controller ? new Controller() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), DEPOSITO_TIMEOUT_MS) : null;

    let response;
    try {
        response = await fetch(DEPOSITO_SUDO_URL, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders(),
            signal: controller ? controller.signal : undefined,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            return res.status(504).json({ success: false, error: 'Tempo limite ao validar comprovativo.' });
        }
        return res.status(502).json({ success: false, error: 'Erro ao comunicar com a API de validacao.' });
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    const responseText = await response.text();
    let data = {};
    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        data = { raw: responseText };
    }

    if (!response.ok) {
        return res.status(response.status).json({
            success: false,
            error: 'Erro na API de validacao.',
            data,
        });
    }

    const respostaTexto = JSON.stringify(data || {});
    const statusValido = data.STATUS === 200 || data.status === 200 || data.sucesso === true || data.success === true;
    if (!statusValido) {
        return res.status(400).json({ success: false, error: 'Comprovativo invalido ou nao confirmado.', data });
    }

    const destino = validarDestinoComprovativo(respostaTexto);
    if (!destino.ok) {
        return res.status(400).json({ success: false, error: 'Comprovativo nao corresponde ao destino configurado.' });
    }

    const transferenciaId = extrairTransferenciaId(data, respostaTexto);
    if (!transferenciaId) {
        return res.status(400).json({ success: false, error: 'Nao foi possivel identificar o ID da transferencia.' });
    }

    const valorKz = extrairValorComprovativo(data, respostaTexto);
    if (!Number.isFinite(valorKz) || valorKz <= 0) {
        return res.status(400).json({ success: false, error: 'Valor invalido no comprovativo.' });
    }

    const valorUsd = valorKz;

    try {
        const { data: user, error: userErr } = await supabase
            .from('usuarios')
            .select('id, telefone, saldo_usd')
            .eq('id', userIdNum)
            .single();

        if (userErr || !user) {
            throw new Error('Utilizador nao encontrado.');
        }

        const { data: bloqueado } = await supabase
            .from('comprovativos_bloqueados')
            .select('id')
            .eq('transferencia_id', transferenciaId)
            .maybeSingle();

        if (bloqueado) {
            throw new Error('Este comprovativo ja foi bloqueado.');
        }

        const { data: duplicado } = await supabase
            .from('depositos')
            .select('id')
            .eq('transferencia_id', transferenciaId)
            .maybeSingle();

        if (duplicado) {
            throw new Error('Este comprovativo ja foi usado.');
        }

        await supabase.from('depositos').insert({
            user_id: userIdNum, transferencia_id: transferenciaId, valor_kz: valorKz, valor_usd: valorKz,
            destino_tipo: destino.tipo, destino_valor: destino.valor, detalhes: data
        });

        const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + valorKz);
        await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', userIdNum);

        await supabase.from('transacoes').insert({
            remetente_id: userIdNum, remetente_nome: 'Deposito Automatico',
            destinatario_id: userIdNum, destinatario_nome: 'Deposito Automatico', valor: valorKz
        });

        notificarSaldoUsuario(user.telefone, {
            novoSaldo,
            mensagem: `Deposito confirmado: ${valorKz.toFixed(2)} KZ adicionados.`
        });
        io.emit('atualizar-historico', { userId: userIdNum });

        res.json({
            success: true,
            novoSaldo,
            valorKz,
            transferenciaId,
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message || 'Falha ao validar depósito.' });
    }
});


// --- ROTA DE TRANSFERГЉNCIA P2P ---
app.post('/transferir', async (req, res) => {
  const { remetenteTelefone, destinoTelefone, valor } = req.body;
  const valorNum = parseFloat(valor);

  if (!Number.isFinite(valorNum) || valorNum < 100) {
    return res.status(400).json({ error: 'O valor minimo de transferencia e 100.00 KZ.' });
  }

  try {
    const remetente = await buscarUsuarioPorTelefone(remetenteTelefone, 'id, nome_completo, telefone, saldo_usd');
    if (!remetente) throw new Error('Remetente não encontrado');

    const destinatario = await buscarUsuarioPorTelefone(destinoTelefone, 'id, nome_completo, telefone, saldo_usd');
    if (!destinatario) throw new Error('Destinatário não encontrado');

    if (Number(remetente.id) === Number(destinatario.id)) {
      throw new Error('Não é permitido transferir para a própria conta.');
    }
    if (toNumberSafe(remetente.saldo_usd) < valorNum) throw new Error('Saldo insuficiente.');

    const novoSaldoRemetente = arredondar2(toNumberSafe(remetente.saldo_usd) - valorNum);
    const novoSaldoDestinatario = arredondar2(toNumberSafe(destinatario.saldo_usd) + valorNum);

    await supabase.from('usuarios').update({ saldo_usd: novoSaldoRemetente }).eq('id', remetente.id);
    await supabase.from('usuarios').update({ saldo_usd: novoSaldoDestinatario }).eq('id', destinatario.id);
    await supabase.from('transacoes').insert({
        remetente_id: remetente.id, remetente_nome: remetente.nome_completo,
        destinatario_id: destinatario.id, destinatario_nome: destinatario.nome_completo, valor: valorNum
    });

    const remetenteNomeSeguro = normalizarTexto(remetente.nome_completo) || String(remetenteTelefone || '');
    const destinatarioNomeSeguro = normalizarTexto(destinatario.nome_completo) || String(destinoTelefone || '');
    const msgDestinatario = `Recebeu um pagamento de ${valorNum.toFixed(2)} KZ de ${remetenteNomeSeguro}.`;
    const msgRemetente = `Fizeste uma transferencia de ${valorNum.toFixed(2)} KZ para ${destinatarioNomeSeguro}.`;
    enviarSMS(destinoTelefone, msgDestinatario);
    enviarSMS(remetenteTelefone, msgRemetente);

    notificarSaldoUsuario(destinatario.telefone, { novoSaldo: novoSaldoDestinatario });
    notificarSaldoUsuario(remetente.telefone, { novoSaldo: novoSaldoRemetente });
    io.emit('atualizar-historico', { userId: Number(remetente.id) });
    io.emit('atualizar-historico', { userId: Number(destinatario.id) });

    res.json({ success: true, novoSaldo: novoSaldoRemetente });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- LEVANTAMENTOS (SAQUES) ---

app.post('/levantamentos/solicitar', async (req, res) => {
    const sessao = exigirSessao(req, res);
    if (!sessao) return;

    const { valor, metodo, unitelTelefone, iban, beneficiarioNome } = req.body;
    const userId = sessao.userId;
    const valorNumerico = Number(String(valor ?? '').trim().replace(',', '.'));
    const metodoNormalizado = String(metodo || '').toLowerCase();
    const VALOR_MINIMO_LEVANTAMENTO = 50;

    if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(valorNumerico) || valorNumerico <= 0 || !metodoNormalizado) {
        return res.status(400).json({ success: false, error: 'Dados de levantamento inválidos.' });
    }

    if (valorNumerico < VALOR_MINIMO_LEVANTAMENTO) {
        return res.status(400).json({ success: false, error: 'O valor minimo para levantamento e 50.00 KZ.' });
    }

    if (!['unitel_money', 'iban'].includes(metodoNormalizado)) { // Fix: Typo in 'método'
        return res.status(400).json({ success: false, error: 'Método de levantamento inválido.' });
    }

    let unitelNormalizado = null; // Declare variables here
    let ibanNormalizado = null;
    let beneficiarioNormalizado = null;
    if (metodoNormalizado === 'unitel_money') {
        unitelNormalizado = assinaturaTelefone(unitelTelefone);
        if (!/^9\d{8}$/.test(unitelNormalizado)) return res.status(400).json({ success: false, error: 'Número Unitel Money inválido' });
    }
    if (metodoNormalizado === 'iban') {
        ibanNormalizado = normalizarDigitos(iban);
        beneficiarioNormalizado = normalizarTexto(beneficiarioNome);
        if (!/^\d{21}$/.test(ibanNormalizado)) return res.status(400).json({ success: false, error: 'IBAN inválido' });
        if (beneficiarioNormalizado.length < 3) return res.status(400).json({ success: false, error: 'Nome inválido' });
    }

    const requestId = String(req.get('x-request-id') || '').trim();
    const chaveProcessamento = `${userId}:${requestId || 'sem-request-id'}`;
    if (levantamentosEmProcessamento.has(chaveProcessamento)) {
        return res.status(409).json({ success: false, error: 'Este levantamento já está a ser processado.' });
    }
    levantamentosEmProcessamento.add(chaveProcessamento);

    try {
        const { data: usuario, error: userErr } = await supabase.from('usuarios').select('*').eq('id', userId).single();
        if (userErr || !usuario) throw new Error('Usuário não encontrado.');

        // Chamada da Função RPC para processar o saque de forma atômica
        const { data: rpcData, error: rpcErr } = await supabase.rpc('solicitar_saque_v2', {
            p_user_id: userId,
            p_valor: valorNumerico,
            p_metodo: metodoNormalizado,
            p_unitel: unitelNormalizado,
            p_iban: ibanNormalizado,
            p_beneficiario: beneficiarioNormalizado,
            p_user_nome: usuario.nome_completo,
            p_user_telefone: usuario.telefone
        });

        if (rpcErr) throw rpcErr;
        const resultado = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        if (!resultado?.success) throw new Error(resultado?.error || 'Falha ao solicitar levantamento.');

        const novoSaldo = resultado.novoSaldo;

        notificarSaldoUsuario(usuario.telefone, {
            novoSaldo,
            mensagem: `Seu levantamento de ${valorNumerico.toFixed(2)} KZ foi solicitado e está pendente.`
        });

        io.emit('atualizar-levantamentos', {
            userId: Number(userId),
            levantamentoId: resultado.levantamentoId,
            status: 'pendente'
        });

        res.json({ success: true, novoSaldo });
    } catch (e) {
        const mensagem = String(e?.message || 'Falha ao solicitar levantamento.');
        const indisponivel = /solicitar_saque_v2|Could not find the function|PGRST202/i.test(mensagem);
        res.status(indisponivel ? 503 : 400).json({
            success: false,
            error: indisponivel ? 'A função de levantamento não está disponível no Supabase. Execute a migração DATABASE_UPDATE.md.' : mensagem
        });
    } finally {
        levantamentosEmProcessamento.delete(chaveProcessamento);
    }
});

app.get('/levantamentos/:userId', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('levantamentos')
            .select('*')
            .eq('user_id', req.params.userId)
            .order('data_solicitacao', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/admin/levantamentos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('levantamentos')
            .select('*')
            .order('data_solicitacao', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/levantamentos/:id/aprovar', async (req, res) => {
    const { senhaAdmin } = req.body;
    const levantamentoId = req.params.id;

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    try {
        const { data: levantamento, error: levErr } = await supabase
            .from('levantamentos')
            .select('*')
            .eq('id', levantamentoId)
            .single();

        if (levErr || !levantamento || levantamento.status !== 'pendente') {
            throw new Error('Levantamento inválido ou já processado.');
        }

        await supabase.from('levantamentos').update({
            status: 'pago', data_resposta: new Date().toISOString(), respondido_por: 'admin'
        }).eq('id', levantamentoId);

        const { data: user } = await supabase.from('usuarios').select('saldo_usd').eq('id', levantamento.user_id).single();

        const saldoAtual = toNumberSafe(user?.saldo_usd);
        notificarSaldoUsuario(levantamento.user_telefone, {
            novoSaldo: saldoAtual,
            mensagem: `Seu levantamento de ${parseFloat(levantamento.valor).toFixed(2)} KZ foi pago.`
        });

        io.emit('atualizar-levantamentos', {
            userId: Number(levantamento.user_id),
            levantamentoId: Number(levantamentoId),
            status: 'pago'
        });

        res.json({ success: true, mensagem: 'Levantamento aprovado com sucesso.' });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/admin/levantamentos/:id/rejeitar', async (req, res) => {
    const { senhaAdmin, motivo } = req.body;
    const levantamentoId = req.params.id;

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    try {
        const { data: levantamento, error: levErr } = await supabase
            .from('levantamentos')
            .select('*')
            .eq('id', levantamentoId)
            .single();

        if (levErr || !levantamento || levantamento.status !== 'pendente') {
            throw new Error('Levantamento inválido ou já processado.');
        }

        const { data: user } = await supabase.from('usuarios').select('saldo_usd').eq('id', levantamento.user_id).single();
        const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + toNumberSafe(levantamento.valor));

        const updateFields = { saldo_usd: novoSaldo };
        if (levantamento.metodo === 'unitel_money') updateFields.unitel_money = null;
        else {
            updateFields.iban = null;
            updateFields.beneficiario_nome = null;
        }

        await supabase.from('usuarios').update(updateFields).eq('id', levantamento.user_id);
        await supabase.from('levantamentos').update({
            status: 'rejeitado',
            motivo_rejeicao: motivo || null,
            data_resposta: new Date().toISOString(),
            respondido_por: 'admin'
        }).eq('id', levantamentoId);

        if (levantamento.metodo) {
            io.emit('atualizar-dados-bancarios', { userId: Number(levantamento.user_id) });
        }

        notificarSaldoUsuario(levantamento.user_telefone, {
            novoSaldo: novoSaldo,
            mensagem: `Seu levantamento de ${parseFloat(levantamento.valor).toFixed(2)} KZ foi rejeitado. O valor voltou para sua conta.`
        });

        io.emit('atualizar-levantamentos', {
            userId: Number(levantamento.user_id),
            levantamentoId: Number(levantamentoId),
            status: 'rejeitado'
        });

        res.json({ success: true, mensagem: 'Levantamento rejeitado e saldo devolvido.' });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/admin/levantamentos/:id/eliminar', async (req, res) => {
    const { senhaAdmin } = req.body;
    const levantamentoId = req.params.id;

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    try {
        const { data, error } = await supabase
            .from('levantamentos')
            .delete()
            .eq('id', levantamentoId)
            .select('user_id')
            .single();

        if (error) {
            return res.status(404).json({ success: false, error: 'Levantamento nГЈo encontrado.' });
        }

        io.emit('atualizar-levantamentos', { userId: Number(data.user_id), levantamentoId: Number(levantamentoId), status: 'eliminado' });

        res.json({ success: true, mensagem: 'Registo de levantamento eliminado com sucesso.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- OTP DE CADASTRO ---
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

        const codigo = await enviarOTPCadastro(telefoneAssinatura);
        otpStore.set(telefoneAssinatura, {
            codigo,
            nome: nomeLimpo,
            senha: senhaLimpa,
            indicado_por: indicado_por || null,
            expira: Date.now() + OTP_EXPIRA_MS,
            enviadoEm: Date.now(),
            tentativas: 0
        });
        res.json({ success: true, telefone: telefoneAssinatura, expiraEmSegundos: Math.floor(OTP_EXPIRA_MS / 1000), mensagem: 'Codigo de confirmacao enviado por SMS.' });
    } catch (error) {
        console.error('Erro ao solicitar OTP:', error);
        res.status(500).json({ success: false, error: error.message || 'Erro ao enviar o codigo.' });
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
        if (pendente.expira <= Date.now()) {
            otpStore.delete(telefoneAssinatura);
            return res.status(400).json({ success: false, error: 'Codigo expirado. Solicite um novo codigo.' });
        }
        if ((pendente.tentativas || 0) >= OTP_MAX_TENTATIVAS) {
            otpStore.delete(telefoneAssinatura);
            return res.status(429).json({ success: false, error: 'Limite de tentativas excedido.' });
        }
        if (String(pendente.codigo) !== codigo) {
            pendente.tentativas = (pendente.tentativas || 0) + 1;
            if (pendente.tentativas >= OTP_MAX_TENTATIVAS) otpStore.delete(telefoneAssinatura);
            return res.status(401).json({ success: false, error: 'Codigo de confirmacao incorreto.' });
        }

        const existente = await buscarUsuarioPorTelefone(telefoneAssinatura, 'id');
        if (existente) {
            otpStore.delete(telefoneAssinatura);
            return res.status(400).json({ success: false, error: 'Este numero ja esta registado.' });
        }

        const payload = {
            nome_completo: pendente.nome,
            telefone: telefoneAssinatura,
            senha: pendente.senha,
            saldo_usd: 50.00
        };
        const indicadoPorNum = parseInt(pendente.indicado_por);
        if (Number.isInteger(indicadoPorNum) && indicadoPorNum > 0) payload.indicado_por = indicadoPorNum;

        const { data, error } = await supabase.from('usuarios').insert(payload).select('id, nome_completo, telefone, saldo_usd').single();
        if (error) throw error;
        otpStore.delete(telefoneAssinatura);
        res.status(201).json({ success: true, usuario: data });
    } catch (error) {
        console.error('Erro ao confirmar cadastro:', error);
        res.status(500).json({ success: false, error: 'Erro ao criar a conta.' });
    }
});

// --- OUTRAS ROTAS (LOGIN/BUSCA) ---

app.post('/auth/login', async (req, res) => {
    const { telefone, senha } = req.body;

    try {
        const usuarios = await buscarUsuariosPorTelefone(telefone, 'id, nome_completo, telefone, senha, saldo_usd, bloqueado');
        const user = usuarios.find(u => String(u.senha) === String(senha).trim());
        
        if (!user) return res.status(401).json({ error: 'Dados incorretos' });
        if (user.bloqueado) return res.status(403).json({ error: 'Usuário bloqueado pelo suporte. Contacte o suporte +55 926240472' });

        const { senha: _senha, bloqueado: _bloqueado, ...usuarioSeguro } = user;
        const sessionToken = criarSessao(user.id);
        res.json({ success: true, usuario: { ...usuarioSeguro, sessionToken } });
    } catch (err) {
        console.error("ERRO NO LOGIN:", err);
        if (err.message && err.message.includes('column "bloqueado" does not exist')) {
            res.status(500).json({ error: 'Erro crítico: A coluna "bloqueado" não existe no banco de dados.' });
        } else {
            res.status(500).json({ error: 'Erro interno no servidor. Verifique os logs.' });
        }
    }
});

app.post('/auth/alterar-senha', async (req, res) => {
    const { userId, senhaAtual, novaSenha } = req.body;

    if (!userId || !senhaAtual || !novaSenha) {
        return res.status(400).json({ success: false, error: 'Todos os campos são obrigatórios.' });
    }

    try {
        // Busca a senha atual do usuário no banco
        const { data: user, error: fetchErr } = await supabase
            .from('usuarios')
            .select('id, senha')
            .eq('id', userId)
            .single();

        if (fetchErr || !user) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

        // Verifica se a senha atual digitada bate com a do banco
        if (String(user.senha) !== String(senhaAtual).trim()) {
            return res.status(401).json({ success: false, error: 'A senha atual está incorreta.' });
        }

        // Atualiza para a nova senha
        await supabase.from('usuarios').update({ senha: String(novaSenha).trim() }).eq('id', userId);
        res.json({ success: true, mensagem: 'Senha alterada com sucesso!' });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Erro interno ao alterar senha.' });
    }
});

app.get('/config/suporte', async (req, res) => {
    try {
        const { data, error } = await supabase.from('suporte_config').select('mensagem, ativo').eq('id', 1).single();
        if (error) return res.json({ mensagem: '', ativo: false });
        res.json({ mensagem: data.mensagem || '', ativo: !!data.ativo });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// --- 1. BUSCA CORRIGIDA (Agora envia ID e Saldo) ---
app.get('/buscar-usuario/:telefone', async (req, res) => {
    try {
        const user = await buscarUsuarioPorTelefone(req.params.telefone);
        if (user) res.json(user);
        else res.status(404).json({ error: 'NГЈo encontrado' });
    } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

app.get('/dados-bancarios/:userId', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('usuarios')
            .select('id, nome_completo, telefone, unitel_money, iban, beneficiario_nome')
            .eq('id', req.params.userId)
            .single();

        if (error || !data) return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        res.json({ success: true, dados: data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/admin/investimentos-usuario/:userId', async (req, res) => {
    const uid = req.params.userId;
    try {
        const { data: usuario, error: userErr } = await supabase.from('usuarios').select('id, nome_completo, telefone, saldo_usd').eq('id', uid).single();
        if (userErr) throw userErr;

        const { data: invRaw, error: invErr } = await supabase.from('investimentos').select('*').eq('user_id', uid).order('data_fim', { ascending: false });
        if (invErr) throw invErr;

        const agora = Date.now();
        const investimentos = (invRaw || []).map(inv => {
            const dias = Math.ceil((new Date(inv.data_fim).getTime() - agora) / 86400000);
            return { ...inv, dias_restantes: Number.isFinite(dias) ? dias : 0 };
        });

        res.json({ success: true, usuario, investimentos });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- 2. NOVA ROTA: TOTAL DA PLATAFORMA ---
app.get('/admin/total-plataforma', async (req, res) => {
    try {
        const { data } = await supabase.from('usuarios').select('saldo_usd');
        const total = (data || []).reduce((sum, u) => sum + toNumberSafe(u.saldo_usd), 0);
        res.json({ total: arredondar2(total) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3. NOVA ROTA: TOTAL DE USUГЃRIOS CADASTRADOS ---
app.get('/admin/total-usuarios', async (req, res) => {
    try {
        const { count } = await supabase.from('usuarios').select('*', { count: 'exact', head: true });
        res.json({ total: count || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/listar-usuarios', async (req, res) => {
    try {
        const { data } = await supabase.from('usuarios').select('id, nome_completo, telefone, saldo_usd').order('id', { ascending: false }).limit(500);
        res.json(data || []);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ROTA DE ESTATÍSTICAS DE CONVITE
app.get('/referrals/stats/:userId', async (req, res) => {
    const uid = req.params.userId;
    try {
        // Total de pessoas convidadas
        const { count } = await supabase
            .from('usuarios')
            .select('*', { count: 'exact', head: true })
            .eq('indicado_por', uid);

        // Total de bônus recebidos
        const { data: bonusData } = await supabase
            .from('transacoes')
            .select('valor')
            .eq('destinatario_id', uid)
            .ilike('remetente_nome', '%Bônus de Convite%')
            .eq('vinculado', false);

        const totalBonus = (bonusData || []).reduce((sum, tx) => sum + toNumberSafe(tx.valor), 0);
        res.json({ totalInvited: count || 0, totalBonus: arredondar2(totalBonus) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOVA ROTA PARA VINCULAR BÔNUS AO SALDO
app.post('/referrals/vincular', async (req, res) => {
    const { userId } = req.body;
    try {
        // 1. Buscar bônus não vinculados
        const { data: bonusPendentes } = await supabase
            .from('transacoes')
            .select('id, valor')
            .eq('destinatario_id', userId)
            .ilike('remetente_nome', '%Bônus de Convite%')
            .eq('vinculado', false);

        if (!bonusPendentes || bonusPendentes.length === 0) {
            return res.status(400).json({ success: false, error: 'Não há bônus acumulados para vincular.' });
        }

        const totalParaVincular = bonusPendentes.reduce((sum, tx) => sum + toNumberSafe(tx.valor), 0);

        // 2. Buscar usuário e atualizar saldo
        const { data: user } = await supabase.from('usuarios').select('saldo_usd, telefone').eq('id', userId).single();
        const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + totalParaVincular);

        await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', userId);

        // 3. Marcar transações como vinculadas
        const ids = bonusPendentes.map(b => b.id);
        await supabase.from('transacoes').update({ vinculado: true }).in('id', ids);

        notificarSaldoUsuario(user.telefone, { novoSaldo, mensagem: `Bônus de ${totalParaVincular.toFixed(2)} KZ vinculado ao seu saldo!` });
        res.json({ success: true, novoSaldo });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/usuario-mais-rico', async (req, res) => {
    try {
        const { data, error } = await supabase.from('usuarios').select('*').order('saldo_usd', { ascending: false }).limit(1).single();
        if (error || !data) {
            return res.status(404).json({ success: false, error: 'Nenhum utilizador encontrado.' });
        }
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/alterar-nome', async (req, res) => {
    const { userId, novoNome, senhaAdmin } = req.body;
    const userIdNum = parseInt(userId);

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
        return res.status(400).json({ success: false, error: 'Utilizador invalido.' });
    }

    const nomeLimpo = String(novoNome || '').trim();
    if (nomeLimpo.length < 3) {
        return res.status(400).json({ success: false, error: 'Nome invalido.' });
    }

    try {
        const { data, error } = await supabase.from('usuarios').update({ nome_completo: nomeLimpo }).eq('id', userIdNum).select().single();
        if (error || !data) {
            return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        }
        res.json({ success: true, nome: data.nome_completo });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.post('/admin/alterar-senha', async (req, res) => {
    const { userId, novaSenha, senhaAdmin } = req.body;

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    if (!novaSenha || String(novaSenha).trim().length < 4) {
        return res.status(400).json({ success: false, error: 'Nova senha invГЎlida.' });
    }

    try {
        const { error } = await supabase.from('usuarios').update({ senha: String(novaSenha).trim() }).eq('id', userId);
        if (error) {
            return res.status(404).json({ success: false, error: 'Utilizador nГЈo encontrado.' });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/alterar-dados-bancarios', async (req, res) => {
    const { userId, unitel_money, iban, beneficiario_nome, senhaAdmin } = req.body;
    const userIdNum = parseInt(userId);

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
        return res.status(400).json({ success: false, error: 'Utilizador invalido.' });
    }

    const unitelLimpo = String(unitel_money || '').trim();
    const ibanLimpo = String(iban || '').trim();
    const beneficiarioLimpo = String(beneficiario_nome || '').trim();

    if (!unitelLimpo && !ibanLimpo) {
        return res.status(400).json({ success: false, error: 'Informe o Unitel Money ou o IBAN.' });
    }

    if (unitelLimpo && !/^9\d{8}$/.test(unitelLimpo)) {
        return res.status(400).json({ success: false, error: 'Numero Unitel Money invalido. Deve ter 9 digitos.' });
    }

    if (ibanLimpo && !/^\d{21}$/.test(ibanLimpo)) {
        return res.status(400).json({ success: false, error: 'IBAN invalido. Deve ter 21 numeros.' });
    }

    if (ibanLimpo && beneficiarioLimpo.length < 3) {
        return res.status(400).json({ success: false, error: 'Nome do beneficiario invalido.' });
    }

    try {
        const update = {};
        if (unitelLimpo) {
            update.unitel_money = unitelLimpo;
        }
        if (ibanLimpo) {
            update.iban = ibanLimpo;
            update.beneficiario_nome = beneficiarioLimpo;
        }

        const { data, error } = await supabase.from('usuarios').update(update).eq('id', userIdNum).select().single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        }

        io.emit('atualizar-dados-bancarios', { userId: userIdNum });
        res.json({ success: true, dados: data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/limpar-dados-bancarios', async (req, res) => {
    const { userId, senhaAdmin } = req.body;
    const userIdNum = parseInt(userId);

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
        return res.status(400).json({ success: false, error: 'Utilizador invalido.' });
    }

    try {
        const { data, error } = await supabase.from('usuarios').update({ unitel_money: null, iban: null, beneficiario_nome: null }).eq('id', userIdNum).select().single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        }

        io.emit('atualizar-dados-bancarios', { userId: userIdNum });
        res.json({ success: true, dados: data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.post('/admin/config/suporte', async (req, res) => {
    const { senhaAdmin, mensagem, ativo } = req.body;

    if (senhaAdmin !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    const mensagemFinal = String(mensagem || '').trim();
    const ativoFinal = !!ativo;

    try {
        await supabase.from('suporte_config').update({ mensagem: mensagemFinal, ativo: ativoFinal, atualizado_em: new Date().toISOString() }).eq('id', 1);
        io.emit('atualizar-suporte', { ativo: ativoFinal, mensagem: mensagemFinal });
        res.json({ success: true, ativo: ativoFinal, mensagem: mensagemFinal });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/ajustar-saldo', async (req, res) => {
    const { userId, valor, operacao } = req.body;
    
    try {
        const { data: user, error: fetchErr } = await supabase.from('usuarios').select('saldo_usd, telefone').eq('id', userId).single();
        if (fetchErr || !user) return res.status(404).json({ success: false, error: "Usuário não encontrado." });

        let novoSaldo;
        const valorNum = toNumberSafe(valor);

        if (operacao === 'soma') {
            novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + valorNum);
        } else {
            if (toNumberSafe(user.saldo_usd) < valorNum) {
                return res.status(400).json({ success: false, error: "Saldo insuficiente." });
            }
            novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) - valorNum);
        }
        
        const { error: updateErr } = await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', userId);
        if (updateErr) throw updateErr;

        // Define um nome claro para o histórico dependendo da operação
        const nomeOperacao = operacao === 'soma' ? 'Depósito pelo Suporte' : 'Ajuste de Saldo (Débito)';

        await supabase.from('transacoes').insert({
            remetente_id: null, // Sistema não tem ID de usuário
            remetente_nome: nomeOperacao,
            destinatario_id: userId, 
            destinatario_nome: user.nome_completo,
            valor: operacao === 'soma' ? valorNum : -valorNum
        });

        notificarSaldoUsuario(user.telefone, { 
            novoSaldo,
            mensagem: `Administrador ${operacao === 'soma' ? 'adicionou' : 'removeu'} ${valorNum} KZ na sua conta.`
        });

        res.json({ success: true, novoSaldo });
    } catch (e) { 
        res.status(500).json({ success: false, error: e.message }); 
    }
});

app.post('/admin/bonus-global', async (req, res) => {
    const { valor } = req.body;
    const valorNum = toNumberSafe(valor);
    try {
        const { data: usuarios, error: fetchErr } = await supabase.from('usuarios').select('id, saldo_usd, telefone');
        if (fetchErr) throw fetchErr;

        for (const u of usuarios) {
            const novoSaldo = arredondar2(toNumberSafe(u.saldo_usd) + valorNum);
            await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', u.id);
            
            notificarSaldoUsuario(u.telefone, {
                novoSaldo,
                mensagem: `🎁 Você recebeu um bônus de ${valorNum} KZ!`
            });
        }

        res.json({ success: true, usuariosAtualizados: usuarios.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/depositos/bloquear', async (req, res) => {
    const { senhaAdmin, transferenciaId, motivo } = req.body;
    if (senhaAdmin !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Não autorizado.' });

    try {
        const { data: existe } = await supabase.from('comprovativos_bloqueados').select('id').eq('transferencia_id', transferenciaId).maybeSingle();
        if (existe) return res.status(400).json({ success: false, error: 'Já bloqueado.' });

        await supabase.from('comprovativos_bloqueados').insert({
            transferencia_id: transferenciaId,
            motivo: motivo || 'Sem motivo',
            criado_por: 'admin'
        });
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// --- 5. ROTA PARA ELIMINAR USUГЃRIO ---
app.post('/admin/eliminar-usuario', async (req, res) => {
    const { userId, senha } = req.body;
    
    // Verificar a senha admin (123)
    if (senha !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }
    
    try {
        await supabase.from('investimentos').delete().eq('user_id', userId);
        await supabase.from('levantamentos').delete().eq('user_id', userId);
        await supabase.from('usuarios').delete().eq('id', userId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// BUSCAR HISTГ“RICO DE TRANSAГ‡Г•ES DO USUГЃRIO
app.get('/historico/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    const { data: transacoesRaw } = await supabase.from('transacoes')
        .select('*')
        .or(`remetente_id.eq.${userId},destinatario_id.eq.${userId}`)
        .order('data', { ascending: false });

    const { data: levantamentosRaw } = await supabase.from('levantamentos')
        .select('*')
        .eq('user_id', userId)
        .order('data_solicitacao', { ascending: false });

    const { data: excluidos } = await supabase.from('historico_excluido').select('*').eq('user_id', userId);

    const historicoExcluidoSet = new Set(
      (excluidos || []).map(r => `${String(r.registro_tipo)}-${Number(r.registro_id)}`)
    );
    
    const transacoes = (transacoesRaw || [])
      .filter(t => !historicoExcluidoSet.has(`transacao-${Number(t.id)}`))
      .map(t => {
      const tipo = tipoTransacao(t, userId);
      return {
        id: t.id,
        titulo: tituloTransacao(t, userId, tipo),
        tipo: tipo,
        valor: parseFloat(t.valor),
        data: t.data,
        icon: '📝',
        nome: t.remetente_nome
      };
    });

    const historicoLevantamentos = (levantamentosRaw || [])
      .filter(l => !historicoExcluidoSet.has(`levantamento-${Number(l.id)}`))
      .map(l => {
      const valor = Math.abs(parseFloat(l.valor));
      const status = String(l.status || 'pendente').toLowerCase();

      if (status === 'pago') {
        return {
          id: `levantamento-${l.id}`,
          titulo: 'Levantamento pago',
          tipo: 'levantamento_pago',
          valor: -valor,
          data: l.data_resposta || l.data_solicitacao,
          icon: 'вњ…',
          nome: 'Levantamento',
          status
        };
      }

      if (status === 'rejeitado') {
        return {
          id: `levantamento-${l.id}`,
          titulo: 'Levantamento rejeitado (valor devolvido)',
          tipo: 'levantamento_rejeitado',
          valor: valor,
          data: l.data_resposta || l.data_solicitacao,
          icon: 'в†©пёЏ',
          nome: 'Levantamento',
          status
        };
      }

      return {
        id: `levantamento-${l.id}`,
        titulo: 'Levantamento pendente',
        tipo: 'levantamento_pendente',
        valor: -valor,
        data: l.data_solicitacao,
        icon: 'рџЏ¦',
        nome: 'Levantamento',
        status
      };
    });
    
    const historicoCompleto = [...transacoes, ...historicoLevantamentos].sort(
      (a, b) => new Date(b.data) - new Date(a.data)
    );

    res.json(historicoCompleto);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histГіrico' });
  }
});

app.post('/historico/eliminar', async (req, res) => {
  const { userId, registroId } = req.body;
  const userIdNum = parseInt(userId);
  const registroIdTexto = String(registroId || '');

  if (!Number.isInteger(userIdNum) || userIdNum <= 0 || !registroIdTexto.includes('-')) {
    return res.status(400).json({ success: false, error: 'Dados invalidos para eliminar historico.' });
  }

  const partes = registroIdTexto.split('-');
  const registroTipo = partes[0];
  const idNum = parseInt(partes[1]);

  if (!['transacao', 'levantamento'].includes(registroTipo) || !Number.isInteger(idNum) || idNum <= 0) {
    return res.status(400).json({ success: false, error: 'Registro de historico invalido.' });
  }

  try {
    const tabela = registroTipo === 'transacao' ? 'transacoes' : 'levantamentos';
    const colunaUser = registroTipo === 'transacao' ? 'remetente_id' : 'user_id';
    
    const { data: existe } = await supabase.from(tabela).select('id').eq('id', idNum).maybeSingle();
    if (!existe) return res.status(404).json({ success: false, error: 'Registro não encontrado.' });

    await supabase.from('historico_excluido').upsert({
      user_id: userIdNum,
      registro_tipo: registroTipo,
      registro_id: idNum
    }, { onConflict: 'user_id, registro_tipo, registro_id' });

    io.emit('atualizar-historico', { userId: userIdNum, registroTipo, registroId: idNum });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});



// BUSCAR INVESTIMENTOS DO USUГЃRIO
app.get('/meus-investimentos/:userId', async (req, res) => {
  try {
    const { data } = await supabase.from('investimentos').select('*').eq('user_id', req.params.userId).order('data_fim', { ascending: false });
    const investimentos = (data || []).map(inv => {
        const dias = Math.ceil((new Date(inv.data_fim).getTime() - Date.now()) / 86400000);
        return { ...inv, dias_restantes: Number.isFinite(dias) ? dias : 0 };
    });
    res.json(investimentos);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar investimentos' });
  }
});
// ROTA PARA CRIAR INVESTIMENTO
app.post('/investir', async (req, res) => {
  const { userId, valor, taxa, dias } = req.body;
  const diasPlano = parseInt(dias);
  const taxaInformada = parseFloat(taxa);
  const planosPermitidos = {
    7: 0.20,
    30: 0.70,
    90: 2.00
  };
  const taxaPlano = planosPermitidos[diasPlano];

  if (!taxaPlano || !Number.isFinite(taxaInformada) || Math.abs(taxaInformada - taxaPlano) > 0.0001) {
    return res.status(400).json({ error: 'Plano de investimento invalido.' });
  }

  try {
    const { data: user, error: userErr } = await supabase.from('usuarios').select('id, saldo_usd, telefone, indicado_por').eq('id', userId).single();
    if (userErr || !user) throw new Error('Utilizador não encontrado');

    if (toNumberSafe(user.saldo_usd) < valor) throw new Error('Saldo insuficiente para investir');

    const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) - valor);
    const retorno = valor + (valor * taxaPlano);
    const dataFim = new Date();
    dataFim.setDate(dataFim.getDate() + diasPlano);

    await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', userId);
    await supabase.from('investimentos').insert({
        user_id: userId, valor_investido_usd: valor, valor_retorno_usd: retorno, data_fim: dataFim.toISOString()
    });

    await supabase.from('transacoes').insert({
        remetente_id: userId, 
        remetente_nome: 'Investimento', 
        destinatario_id: null, 
        destinatario_nome: 'Aplicação de Capital', 
        valor: -valor
    });

    // LÓGICA DE BÔNUS DE CONVITE (10%)
    if (user.indicado_por) {
        const bonus = arredondar2(valor * 0.10);
        const { data: padrinho } = await supabase.from('usuarios').select('id, saldo_usd, telefone').eq('id', user.indicado_por).single();
        
        if (padrinho) {
            // Registra a transação de bônus mas NÃO atualiza o saldo do padrinho ainda
            await supabase.from('transacoes').insert({
                remetente_id: userId, 
                remetente_nome: 'Bônus de Convite',
                destinatario_id: padrinho.id, 
                destinatario_nome: 'Sistema', 
                valor: bonus,
                vinculado: false
            });
            
            notificarSaldoUsuario(padrinho.telefone, { mensagem: `Acabou de acumular ${bonus.toFixed(2)} KZ em bônus de convite!` });
        }
    }

    notificarSaldoUsuario(user.telefone, { novoSaldo, mensagem: 'Novo investimento aplicado com sucesso.' });
    io.emit('atualizar-investimentos', { userId: Number(userId), acao: 'criado' });

    res.json({ success: true, novoSaldo, retornoTotal: retorno });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/resgatar-investimento', async (req, res) => {
  const { investmentId, userId } = req.body;
  
  try {
    const { data: inv, error: invErr } = await supabase.from('investimentos').select('*').eq('id', investmentId).eq('user_id', userId).single();
    if (invErr || !inv) throw new Error('Investimento não encontrado');

    if (new Date() < new Date(inv.data_fim)) {
      return res.status(400).json({ success: false, vencido: false, error: 'Prazo ainda não venceu', dataFim: inv.data_fim });
    }
    
    const { data: user } = await supabase.from('usuarios').select('saldo_usd, telefone').eq('id', userId).single();
    const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + toNumberSafe(inv.valor_retorno_usd));

    await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', userId);
    await supabase.from('transacoes').insert({
      remetente_id: userId, remetente_nome: 'Ganho do investimento', destinatario_id: userId, destinatario_nome: 'Ganho do investimento', valor: inv.valor_retorno_usd
    });
    await supabase.from('investimentos').delete().eq('id', investmentId);

    notificarSaldoUsuario(user.telefone, { novoSaldo, mensagem: `Investimento resgatado: ${parseFloat(inv.valor_retorno_usd).toFixed(2)} KZ creditado.` });
    io.emit('atualizar-investimentos', { userId: Number(userId), investmentId: Number(investmentId), acao: 'resgatado' });
    
    res.json({ success: true, novoSaldo, valorRecebido: inv.valor_retorno_usd });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/admin/investimentos/:id/cancelar', async (req, res) => {
  const investimentoId = parseInt(req.params.id);
  const { senhaAdmin } = req.body;

  if (senhaAdmin !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Não autorizado.' });

  if (!Number.isInteger(investimentoId) || investimentoId <= 0) {
    return res.status(400).json({ success: false, error: 'Investimento invalido.' });
  }

  try {
    const { data: inv, error: invErr } = await supabase.from('investimentos').select('*, usuarios(telefone, saldo_usd)').eq('id', investimentoId).single();
    if (invErr || !inv) throw new Error('Investimento não encontrado.');

    const valorDevolvido = parseFloat(inv.valor_investido_usd);
    const novoSaldo = arredondar2(toNumberSafe(inv.usuarios.saldo_usd) + valorDevolvido);

    await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', inv.user_id);
    await supabase.from('transacoes').insert({
      remetente_id: inv.user_id, remetente_nome: 'Cancelamento de investimento', destinatario_id: inv.user_id, destinatario_nome: 'Cancelamento de investimento', valor: valorDevolvido
    });
    await supabase.from('investimentos').delete().eq('id', investimentoId);

    notificarSaldoUsuario(inv.usuarios.telefone, { novoSaldo, mensagem: `Investimento cancelado pelo administrador. ${valorDevolvido.toFixed(2)} KZ devolvido.` });
    io.emit('atualizar-investimentos', { userId: Number(inv.user_id), investmentId, acao: 'cancelado_admin' });

    res.json({ success: true, userId: Number(inv.user_id), novoSaldo, valorDevolvido });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Tratamento de erros do multer (upload de comprovativo)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, error: `Arquivo excede ${DEPOSITO_MAX_FILE_MB}MB.` });
        }
        return res.status(400).json({ success: false, error: err.message });
    }

    if (err?.message === 'Tipo de arquivo nao suportado. Envie PDF ou imagem.') {
        return res.status(400).json({ success: false, error: err.message });
    }

    if (err) {
        console.error('Erro no servidor:', err);
        return res.status(500).json({ success: false, error: 'Erro ao processar comprovativo.' });
    }

    next();
});


// --- INICIALIZAГ‡ГѓO ---

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, '0.0.0.0', () => {
    console.log(`рџљЂ API KWANZA NEXUS na Render ativa!`);
});
