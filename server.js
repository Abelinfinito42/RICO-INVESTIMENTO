﻿﻿﻿const express = require('express');
const cors = require('cors');
const http = require('http');
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

// Servir os arquivos estáticos da pasta 'site'
app.use(express.static(path.join(__dirname, 'site')));

// Servir os arquivos estáticos da pasta 'paynel'
app.use('/paynel', express.static(path.join(__dirname, 'paynel')));


// CONFIGURAÇÃO SUPABASE (Credenciais do RICO INVESTIMENTO)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgwxtbxgxozxicmipadr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_cAFfrLoGx4MbG0J3IXwINw_f6NOuPkQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CONFIGURACOES DE DEPOSITO
const DEPOSITO_API_KEY = process.env.DEPOSITO_API_KEY || '32y3103KsiiaoL57dt38blJ1TWKxeDrUYucBeraKgI47hr2RbsJBOsJEtScy590203';
const DEPOSITO_DESTINO_NUMERO = '926240472';
const DEPOSITO_DESTINO_IBAN = '';
const DEPOSITO_TAXA_KZ = 850;
const DEPOSITO_SUDO_URL = 'https://comprovativos.sudomakes.com/validar/';
const DEPOSITO_MAX_FILE_MB = 10;
const DEPOSITO_TIMEOUT_MS = 25000;

const SMS_API_URL = 'https://smsapi.sudomakes.com/api/enviar-sms';
const SMS_API_KEY = process.env.SMS_API_KEY || 'hEc65zq9ipXOJeprFj4zMeW+OCiWAWohyoqSPeBqJX17ZD4Xgw8UGQiG5I5Dcs4G';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123';

function toNumberSafe(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function arredondar2(value) {
    return Number(toNumberSafe(value).toFixed(2));
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

    if (remetenteNome.includes('deposito')) return 'deposito';
    if (remetenteNome.includes('ganho do investimento')) return 'ganho';
    if (remetenteNome.includes('cancelamento de investimento')) return 'cancelamento_investimento';
    if (destinatarioNome.includes('investimento') || remetenteNome === 'sistema') return 'investimento';

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
        const match = respostaTexto.match(/(ID|REF|TRANSACAO)[^0-9]*([0-9]{6,})/i);
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
    const userIdNum = parseInt(req.body.userId);

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

    const valorUsd = Number((valorKz / DEPOSITO_TAXA_KZ).toFixed(2));

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
            user_id: userIdNum, transferencia_id: transferenciaId, valor_kz: valorKz, valor_usd: valorUsd,
            destino_tipo: destino.tipo, destino_valor: destino.valor, detalhes: data
        });

        const novoSaldo = arredondar2(toNumberSafe(user.saldo_usd) + valorUsd);
        await supabase.from('usuarios').update({ saldo_usd: novoSaldo }).eq('id', userIdNum);

        await supabase.from('transacoes').insert({
            remetente_id: userIdNum, remetente_nome: 'Deposito Automatico',
            destinatario_id: userIdNum, destinatario_nome: 'Deposito Automatico', valor: valorUsd
        });

        notificarSaldoUsuario(user.telefone, {
            novoSaldo,
            mensagem: `Deposito confirmado: ${valorKz.toFixed(2)} KZ adicionados.`
        });
        io.emit('atualizar-historico', { userId: userIdNum });

        res.json({
            success: true,
            novoSaldo,
            valorUsd,
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

  if (!Number.isFinite(valorNum) || valorNum < 1) {
    return res.status(400).json({ error: 'O valor minimo de transferencia e 1.00 USD.' });
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
    const msgDestinatario = `Recebeu um pagamento de ${valorNum.toFixed(2)} USD de ${remetenteNomeSeguro}.`;
    const msgRemetente = `Fizeste uma transferencia de ${valorNum.toFixed(2)} USD para ${destinatarioNomeSeguro}.`;
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
    const { userId, valor, metodo, unitelTelefone, iban, beneficiarioNome } = req.body;
    const valorNumerico = parseFloat(valor);
    const metodoNormalizado = String(metodo || '').toLowerCase();
    const VALOR_MINIMO_LEVANTAMENTO = 0.06;

    if (!userId || !valorNumerico || valorNumerico <= 0 || !metodoNormalizado) {
        return res.status(400).json({ success: false, error: 'Dados de levantamento inválidos.' });
    }

    if (valorNumerico < VALOR_MINIMO_LEVANTAMENTO) {
        return res.status(400).json({ success: false, error: 'O valor minimo para levantamento e 0.06 USD.' });
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

    try {
        const { data: usuario, error: userErr } = await supabase.from('usuarios').select('*').eq('id', userId).single();
        if (userErr || !usuario) throw new Error('Usuário não encontrado.');

        if (toNumberSafe(usuario.saldo_usd) < valorNumerico) {
            throw new Error('Saldo insuficiente para solicitar levantamento.');
        }

        const novoSaldo = arredondar2(toNumberSafe(usuario.saldo_usd) - valorNumerico);
        const updateData = { saldo_usd: novoSaldo };

        if (metodoNormalizado === 'unitel_money') updateData.unitel_money = unitelNormalizado;
        if (metodoNormalizado === 'iban') {
            updateData.iban = ibanNormalizado;
            updateData.beneficiario_nome = beneficiarioNormalizado;
        }

        const todosUsuariosResp = await supabase.from('usuarios').select('id,unitel_money,iban');
        if (todosUsuariosResp.error) throw todosUsuariosResp.error;
        const todosUsuarios = Array.isArray(todosUsuariosResp.data) ? todosUsuariosResp.data : [];

        if (metodoNormalizado === 'unitel_money' && todosUsuarios.some((u) => Number(u.id) !== Number(userId) && assinaturaTelefone(u.unitel_money) === unitelNormalizado)) {
            throw new Error('Numero Unitel Money já cadastrado em outra conta.');
        }
        if (metodoNormalizado === 'iban' && todosUsuarios.some((u) => Number(u.id) !== Number(userId) && normalizarDigitos(u.iban) === ibanNormalizado)) {
            throw new Error('IBAN já cadastrado em outra conta.');
        }

        await supabase.from('usuarios').update(updateData).eq('id', userId);
        const { data: levantamento, error: levErr } = await supabase.from('levantamentos').insert({
            user_id: userId, user_nome: usuario.nome_completo, user_telefone: usuario.telefone,
            metodo: metodoNormalizado, valor: valorNumerico, status: 'pendente',
            unitel_telefone: metodoNormalizado === 'unitel_money' ? String(unitelTelefone) : null,
            iban: metodoNormalizado === 'iban' ? String(iban) : null,
            beneficiario_nome: metodoNormalizado === 'iban' ? String(beneficiarioNome).trim() : null
        }).select().single();

        if (levErr) throw levErr;

        notificarSaldoUsuario(usuario.telefone, {
            novoSaldo,
            mensagem: `Seu levantamento de $${valorNumerico.toFixed(2)} foi solicitado e está pendente.`
        });

        io.emit('atualizar-levantamentos', {
            userId: Number(userId),
            levantamentoId: levantamento.id,
            status: 'pendente'
        });

        res.json({ success: true, novoSaldo, levantamento });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
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
            mensagem: `Seu levantamento de $${parseFloat(levantamento.valor).toFixed(2)} foi pago.`
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
            mensagem: `Seu levantamento de $${parseFloat(levantamento.valor).toFixed(2)} foi rejeitado. O valor voltou para sua conta.`
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

// --- OUTRAS ROTAS (LOGIN/CADASTRO/BUSCA) ---

app.post('/auth/cadastro', async (req, res) => {
    const { nome, telefone, senha } = req.body;
    
    try {
        const existente = await buscarUsuarioPorTelefone(telefone);
        if (existente) {
            return res.status(400).json({ success: false, error: 'Este número já está registado' });
        }

        // Sugestão: Adicionar Hash de senha aqui com bcrypt
        const { data, error } = await supabase.from('usuarios').insert({
            nome_completo: normalizarTexto(nome),
            telefone: assinaturaTelefone(telefone),
            senha: String(senha).trim(),
            saldo_usd: 0.06
        }).select().single();

        if (error) throw error;
        res.status(201).json({ success: true, usuario: data });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao processar o cadastro.' });
    }
});

app.post('/auth/login', async (req, res) => {
    const { telefone, senha } = req.body;

    try {
        const usuarios = await buscarUsuariosPorTelefone(telefone, 'id, nome_completo, telefone, senha, saldo_usd, bloqueado');
        const user = usuarios.find(u => String(u.senha) === String(senha).trim());
        
        if (!user) return res.status(401).json({ error: 'Dados incorretos' });
        if (user.bloqueado) return res.status(403).json({ error: 'Usuário bloqueado pelo suporte. Contacte o suporte +55 926240472' });

        res.json({ success: true, usuario: user });
    } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
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

    if (senhaAdmin !== '123') {
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

    if (senhaAdmin !== '123') {
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

    if (senhaAdmin !== '123') {
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

    if (senhaAdmin !== '123') {
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

    if (senhaAdmin !== '123') {
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

        await supabase.from('transacoes').insert({
            remetente_id: userId, remetente_nome: 'Sistema (Ajuste)',
            destinatario_id: userId, destinatario_nome: 'Sistema (Ajuste)',
            valor: operacao === 'soma' ? valorNum : -valorNum
        });

        notificarSaldoUsuario(user.telefone, { 
            novoSaldo,
            mensagem: `Administrador ${operacao === 'soma' ? 'adicionou' : 'removeu'} $${valorNum} na sua conta.`
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
                mensagem: `🎁 Você recebeu um bônus de $${valorNum}!`
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
    if (senha !== '123') {
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
    const { data: user, error: userErr } = await supabase.from('usuarios').select('saldo_usd, telefone').eq('id', userId).single();
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
        remetente_id: userId, remetente_nome: 'Sistema', destinatario_id: userId, destinatario_nome: 'Investimento', valor: -valor
    });

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

    notificarSaldoUsuario(user.telefone, { novoSaldo, mensagem: `Investimento resgatado: $${parseFloat(inv.valor_retorno_usd).toFixed(2)} creditado.` });
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

    notificarSaldoUsuario(inv.usuarios.telefone, { novoSaldo, mensagem: `Investimento cancelado pelo administrador. $${valorDevolvido.toFixed(2)} devolvido.` });
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
