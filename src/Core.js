/**
 * Regras puras de leitura e organização das candidaturas.
 *
 * Nada aqui toca em APIs do Apps Script: recebe strings/Date e devolve objetos.
 * Isso permite testar tudo localmente com `node --test` (ver test/core.test.js).
 */

var DIA_MS = 24 * 60 * 60 * 1000;
var DIAS_SEM_RESPOSTA = 14;
var AGENDA_DIAS_PASSADO = 7;
var AGENDA_DIAS_FUTURO = 30;

var STATUS = {
  AGENDADO: 'Agendado',
  AGUARDANDO: 'Aguardando retorno',
  SEM_RESPOSTA: 'Sem resposta',
  REPROVADO: 'Reprovado',
  DESISTI: 'Desisti',
  OFERTA: 'Oferta',
  CONTRATADO: 'Contratado',
  REMOVIDA: 'Removida da origem',
};

var STATUS_MANUAIS = [
  STATUS.AGENDADO, STATUS.AGUARDANDO, STATUS.SEM_RESPOSTA,
  STATUS.REPROVADO, STATUS.DESISTI, STATUS.OFERTA, STATUS.CONTRATADO,
];

var STATUS_ENCERRADOS = [STATUS.REPROVADO, STATUS.DESISTI, STATUS.CONTRATADO];

var COLUNAS_CANDIDATURAS = [
  'Empresa', 'Cargo', 'RH', '1ª conversa', 'Etapa atual', 'Data última etapa',
  'Próxima etapa', 'Status (auto)', 'Status (manual)', 'Status final',
  'Próximo passo ✍️', 'Notas ✍️', 'Dias parado', 'Link última etapa', 'Origem (linha)',
];

function normalizar(texto) {
  return String(texto == null ? '' : texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function chaveCandidatura(empresa, cargo) {
  return normalizar(empresa) + '|' + normalizar(cargo);
}

/** "01/09", "16/09/2026", "5/10/26" → {y, m, d}; qualquer outra coisa → null. */
function lerData(texto, anoPadrao) {
  var m = String(texto == null ? '' : texto).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (!m) return null;
  var d = Number(m[1]);
  var mes = Number(m[2]);
  var ano = m[3] ? Number(m[3]) : anoPadrao;
  if (ano < 100) ano += 2000;
  if (mes < 1 || mes > 12 || d < 1 || d > 31) return null;
  return { y: ano, m: mes, d: d };
}

/** "12:25", "10h", "9:30h", "5pm – 5:40pm (BRT)" → {h, min} do início; senão null. */
function lerHora(texto) {
  var m = String(texto == null ? '' : texto).trim().match(/^(\d{1,2})(?:[:h](\d{2}))?\s*h?\s*(am|pm)?/i);
  if (!m) return null;
  var h = Number(m[1]);
  var min = m[2] ? Number(m[2]) : 0;
  var periodo = m[3] ? m[3].toLowerCase() : '';
  if (periodo === 'pm' && h < 12) h += 12;
  if (periodo === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h: h, min: min };
}

function montarDataHora(textoData, textoHora, anoPadrao) {
  var d = lerData(textoData, anoPadrao);
  if (!d) return null;
  var hora = lerHora(textoHora) || { h: 0, min: 0 };
  return new Date(d.y, d.m - 1, d.d, hora.h, hora.min);
}

function pareceLink(texto) {
  return /^https?:\/\/|^meet\.google\.com\//i.test(String(texto || '').trim());
}

/**
 * Lê as colunas de fases em trios Data | Hora | Link, da esquerda para a direita.
 * Trios vazios são pulados; os preenchidos viram Etapa 2, 3, ... em sequência.
 * Um trio que não começa com data vira nota da etapa.
 */
function lerEtapas(celulas, anoPadrao) {
  var etapas = [];
  for (var i = 0; i < celulas.length; i += 3) {
    var trio = celulas.slice(i, i + 3).map(function (c) { return String(c == null ? '' : c).trim(); });
    if (trio.every(function (c) { return c === ''; })) continue;
    var numero = etapas.length + 2;
    var data = montarDataHora(trio[0], trio[1], anoPadrao);
    if (data) {
      etapas.push({ numero: numero, data: data, nota: '', link: trio[2] || '' });
    } else {
      etapas.push({
        numero: numero,
        data: null,
        nota: trio.filter(function (c) { return c && !pareceLink(c); }).join(' · '),
        link: trio.filter(pareceLink)[0] || '',
      });
    }
  }
  return etapas;
}

function rotuloEtapa(etapa) {
  var base = etapa.numero === 1 ? '1ª conversa' : 'Etapa ' + etapa.numero;
  return etapa.nota ? base + ' — ' + etapa.nota : base;
}

function inicioDoDia(data) {
  return new Date(data.getFullYear(), data.getMonth(), data.getDate());
}

function diasEntre(antes, depois) {
  return Math.round((inicioDoDia(depois) - inicioDoDia(antes)) / DIA_MS);
}

/**
 * Localiza as colunas da aba de origem pelo cabeçalho. As fases são todas as
 * colunas depois de "link da reunião".
 */
function mapearColunasOrigem(cabecalho) {
  var nomes = cabecalho.map(normalizar);
  var esperado = { empresa: 'empresa', data: 'data', horario: 'horario', cargo: 'cargo', rh: 'rh', link: 'link da reuniao' };
  var mapa = {};
  Object.keys(esperado).forEach(function (campo) {
    var idx = nomes.indexOf(esperado[campo]);
    if (idx < 0) throw new Error('Coluna "' + esperado[campo] + '" não encontrada no cabeçalho da aba de origem.');
    mapa[campo] = idx;
  });
  mapa.fasesInicio = mapa.link + 1;
  return mapa;
}

/**
 * Converte as linhas da aba de origem (valores exibidos, cabeçalho incluso) em
 * candidaturas. `agora` define o que é passado e futuro. `cores` (opcional) é a
 * matriz de cores de fundo da mesma faixa: Empresa em vermelho = reprovada.
 */
function lerCandidaturas(linhas, anoPadrao, agora, cores) {
  var cols = mapearColunasOrigem(linhas[0]);
  var vistas = {};
  var resultado = [];

  for (var i = 1; i < linhas.length; i++) {
    var linha = linhas[i];
    var empresa = String(linha[cols.empresa] || '').trim();
    if (!empresa) continue;
    var cargo = String(linha[cols.cargo] || '').trim();

    var chave = chaveCandidatura(empresa, cargo);
    vistas[chave] = (vistas[chave] || 0) + 1;
    if (vistas[chave] > 1) chave += '#' + vistas[chave];

    var primeira = montarDataHora(linha[cols.data], linha[cols.horario], anoPadrao);
    var etapas = [{ numero: 1, data: primeira, nota: '', link: String(linha[cols.link] || '').trim() }]
      .concat(lerEtapas(linha.slice(cols.fasesInicio), anoPadrao));

    resultado.push(resumirCandidatura({
      chave: chave,
      empresa: empresa,
      cargo: cargo,
      rh: String(linha[cols.rh] || '').trim(),
      primeira: primeira,
      etapas: etapas,
      linhaOrigem: i + 1,
      vermelha: Boolean(cores && cores[i] && corEhVermelha(cores[i][cols.empresa])),
    }, agora));
  }
  return resultado;
}

/** Calcula etapa atual, datas, status automático e dias parado. */
function resumirCandidatura(c, agora) {
  var preenchidas = c.etapas.filter(function (e) { return e.data || e.nota || e.link; });
  var ultima = preenchidas[preenchidas.length - 1] || c.etapas[0];
  var passadas = c.etapas.filter(function (e) { return e.data && e.data <= agora; });
  var futuras = c.etapas
    .filter(function (e) { return e.data && e.data > agora; })
    .sort(function (a, b) { return a.data - b.data; });

  c.etapaAtual = rotuloEtapa(ultima);
  c.numeroEtapaAtual = ultima.numero;
  c.dataUltimaEtapa = passadas.length ? passadas[passadas.length - 1].data : null;
  c.proximaEtapa = futuras.length ? futuras[0].data : null;
  c.linkUltimaEtapa = ultima.link;
  c.diasParado = !c.proximaEtapa && c.dataUltimaEtapa ? diasEntre(c.dataUltimaEtapa, agora) : null;

  if (c.vermelha) c.statusAuto = STATUS.REPROVADO;
  else if (c.proximaEtapa) c.statusAuto = STATUS.AGENDADO;
  else if (c.diasParado != null && c.diasParado > DIAS_SEM_RESPOSTA) c.statusAuto = STATUS.SEM_RESPOSTA;
  else c.statusAuto = STATUS.AGUARDANDO;
  return c;
}

function statusFinal(statusAuto, statusManual) {
  return String(statusManual || '').trim() || statusAuto;
}

function estaEncerrada(status) {
  return STATUS_ENCERRADOS.indexOf(status) >= 0;
}

/**
 * "#f4cccc", "#ff0000", "#cc0000"... → true. Qualquer tom de vermelho da paleta,
 * claro ou escuro; branco, cinza, rosa-lilás e amarelo → false.
 */
function corEhVermelha(hex) {
  var m = String(hex || '').trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return false;
  var r = parseInt(m[1], 16) / 255;
  var g = parseInt(m[2], 16) / 255;
  var b = parseInt(m[3], 16) / 255;
  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  if (max !== r || max === min) return false;
  var luz = (max + min) / 2;
  var saturacao = (max - min) / (1 - Math.abs(2 * luz - 1));
  var matiz = (60 * ((g - b) / (max - min)) + 360) % 360;
  return saturacao >= 0.25 && (matiz <= 15 || matiz >= 345);
}

var COR_ENCERRADA = '#f4cccc';
var COR_FASE_2 = '#fff2cc';

/** Cor da linha na aba Candidaturas: vermelho encerrada, amarelo Etapa 2+, senão nenhuma. */
function corDaLinha(statusFinalDaLinha, etapaAtual) {
  if (estaEncerrada(statusFinalDaLinha)) return COR_ENCERRADA;
  var m = String(etapaAtual || '').match(/^Etapa (\d+)/);
  if (m && Number(m[1]) >= 2) return COR_FASE_2;
  return null;
}

/**
 * Junta as candidaturas lidas da origem com o que já existe na aba
 * Candidaturas, preservando as colunas manuais. Linhas que sumiram da origem
 * são mantidas e marcadas como "Removida da origem".
 *
 * `anteriores` é a matriz da aba Candidaturas (cabeçalho incluso) ou [].
 * Devolve { linhas, status }: linhas na ordem de COLUNAS_CANDIDATURAS, já
 * ordenadas, e o mapa chave → status final.
 */
function mesclarComAnteriores(candidaturas, anteriores) {
  var idx = indiceColunas(COLUNAS_CANDIDATURAS);
  var antigas = {};

  if (anteriores && anteriores.length > 1) {
    var cab = anteriores[0].map(String);
    var pos = {};
    COLUNAS_CANDIDATURAS.forEach(function (nome) { pos[nome] = cab.indexOf(nome); });
    var contagem = {};
    for (var i = 1; i < anteriores.length; i++) {
      var linhaAntiga = COLUNAS_CANDIDATURAS.map(function (nome) {
        return pos[nome] >= 0 ? anteriores[i][pos[nome]] : '';
      });
      if (!String(linhaAntiga[idx['Empresa']]).trim()) continue;
      var chave = chaveCandidatura(linhaAntiga[idx['Empresa']], linhaAntiga[idx['Cargo']]);
      contagem[chave] = (contagem[chave] || 0) + 1;
      if (contagem[chave] > 1) chave += '#' + contagem[chave];
      antigas[chave] = linhaAntiga;
    }
  }

  var status = {};
  var linhas = candidaturas.map(function (c) {
    var antiga = antigas[c.chave];
    delete antigas[c.chave];
    var manual = antiga ? antiga[idx['Status (manual)']] : '';
    status[c.chave] = statusFinal(c.statusAuto, manual);
    return {
      grupo: grupoOrdenacao(statusFinal(c.statusAuto, manual)),
      proxima: c.proximaEtapa,
      ultima: c.dataUltimaEtapa,
      valores: [
        c.empresa, c.cargo, c.rh, c.primeira || '', c.etapaAtual, c.dataUltimaEtapa || '',
        c.proximaEtapa || '', c.statusAuto, manual, statusFinal(c.statusAuto, manual),
        antiga ? antiga[idx['Próximo passo ✍️']] : '', antiga ? antiga[idx['Notas ✍️']] : '',
        c.diasParado == null ? '' : c.diasParado, c.linkUltimaEtapa, c.linhaOrigem,
      ],
    };
  });

  Object.keys(antigas).forEach(function (chave) {
    var valores = antigas[chave].slice();
    valores[idx['Status (auto)']] = STATUS.REMOVIDA;
    valores[idx['Status final']] = statusFinal(STATUS.REMOVIDA, valores[idx['Status (manual)']]);
    valores[idx['Origem (linha)']] = '';
    linhas.push({ grupo: grupoOrdenacao(valores[idx['Status final']]), proxima: null, ultima: null, valores: valores });
  });

  linhas.sort(function (a, b) {
    if (a.grupo !== b.grupo) return a.grupo - b.grupo;
    if (a.proxima && b.proxima) return a.proxima - b.proxima;
    if (a.proxima || b.proxima) return a.proxima ? -1 : 1;
    return (b.ultima || 0) - (a.ultima || 0);
  });
  return { linhas: linhas.map(function (l) { return l.valores; }), status: status };
}

/** 0 = ativa, 1 = removida da origem, 2 = encerrada. */
function grupoOrdenacao(status) {
  if (estaEncerrada(status)) return 2;
  if (status === STATUS.REMOVIDA) return 1;
  return 0;
}

function indiceColunas(colunas) {
  var idx = {};
  colunas.forEach(function (nome, i) { idx[nome] = i; });
  return idx;
}

/** Números do Painel. `status` é o mapa chave → status final de mesclarComAnteriores. */
function montarPainel(candidaturas, status) {
  var porStatus = {};
  var ativas = 0;
  var encerradas = 0;
  var ofertas = 0;
  var maiorEtapa = 1;

  candidaturas.forEach(function (c) {
    var s = status[c.chave] || c.statusAuto;
    porStatus[s] = (porStatus[s] || 0) + 1;
    if (estaEncerrada(s)) encerradas++; else ativas++;
    if (s === STATUS.OFERTA || s === STATUS.CONTRATADO) ofertas++;
    if (c.numeroEtapaAtual > maiorEtapa) maiorEtapa = c.numeroEtapaAtual;
  });

  var funil = [];
  for (var n = 1; n <= maiorEtapa; n++) {
    funil.push([
      n === 1 ? '1ª conversa' : 'Etapa ' + n,
      candidaturas.filter(function (c) { return c.numeroEtapaAtual >= n; }).length,
    ]);
  }

  var paradas = candidaturas
    .filter(function (c) {
      var s = status[c.chave] || c.statusAuto;
      return !estaEncerrada(s) && c.diasParado != null && c.diasParado > DIAS_SEM_RESPOSTA;
    })
    .sort(function (a, b) { return b.diasParado - a.diasParado; })
    .map(function (c) { return [c.empresa, c.cargo, c.etapaAtual, c.dataUltimaEtapa, c.diasParado]; });

  return {
    totais: [['Ativas', ativas], ['Encerradas', encerradas], ['Ofertas', ofertas]],
    porStatus: STATUS_MANUAIS.concat([STATUS.REMOVIDA])
      .filter(function (s) { return porStatus[s]; })
      .map(function (s) { return [s, porStatus[s]]; }),
    funil: funil,
    paradas: paradas,
  };
}

/** Entrevistas de AGENDA_DIAS_PASSADO dias atrás até AGENDA_DIAS_FUTURO dias à frente. */
function montarAgenda(candidaturas, status, agora) {
  var hoje = inicioDoDia(agora);
  var inicio = new Date(hoje.getTime() - AGENDA_DIAS_PASSADO * DIA_MS);
  var fim = new Date(hoje.getTime() + (AGENDA_DIAS_FUTURO + 1) * DIA_MS);
  var itens = [];

  candidaturas.forEach(function (c) {
    var s = status[c.chave] || c.statusAuto;
    if (estaEncerrada(s)) return;
    c.etapas.forEach(function (e) {
      if (!e.data || e.data < inicio || e.data >= fim) return;
      itens.push({ data: e.data, empresa: c.empresa, cargo: c.cargo, etapa: rotuloEtapa(e), link: e.link, status: s });
    });
  });

  return itens.sort(function (a, b) { return a.data - b.data; });
}

/** Resumo diário por e-mail; null quando não há nada a dizer. */
function montarResumoDiario(candidaturas, status, agora, formatarData) {
  var hoje = inicioDoDia(agora);
  var depoisDeAmanha = new Date(hoje.getTime() + 2 * DIA_MS);
  var proximas = montarAgenda(candidaturas, status, agora)
    .filter(function (i) { return i.data >= hoje && i.data < depoisDeAmanha; });
  var paradas = montarPainel(candidaturas, status).paradas;

  if (!proximas.length && !paradas.length) return null;

  var partes = [];
  if (proximas.length) {
    partes.push('Entrevistas de hoje e amanhã:');
    proximas.forEach(function (i) {
      partes.push('• ' + formatarData(i.data) + ' — ' + i.empresa + (i.cargo ? ' (' + i.cargo + ')' : '') +
        ' — ' + i.etapa + (i.link ? '\n  ' + i.link : ''));
    });
  }
  if (paradas.length) {
    if (partes.length) partes.push('');
    partes.push('Paradas há mais de ' + DIAS_SEM_RESPOSTA + ' dias (vale cobrar retorno):');
    paradas.forEach(function (p) {
      partes.push('• ' + p[0] + (p[1] ? ' (' + p[1] + ')' : '') + ' — ' + p[2] + ' — ' + p[4] + ' dias');
    });
  }

  var assunto = 'Candidaturas: ' +
    (proximas.length ? proximas.length + ' entrevista(s) hoje/amanhã' : '') +
    (proximas.length && paradas.length ? ', ' : '') +
    (paradas.length ? paradas.length + ' parada(s)' : '');

  return { assunto: assunto, corpo: partes.join('\n') };
}

if (typeof module !== 'undefined') {
  module.exports = {
    STATUS: STATUS,
    COLUNAS_CANDIDATURAS: COLUNAS_CANDIDATURAS,
    chaveCandidatura: chaveCandidatura,
    lerData: lerData,
    lerHora: lerHora,
    lerEtapas: lerEtapas,
    lerCandidaturas: lerCandidaturas,
    mesclarComAnteriores: mesclarComAnteriores,
    montarPainel: montarPainel,
    montarAgenda: montarAgenda,
    montarResumoDiario: montarResumoDiario,
    corEhVermelha: corEhVermelha,
    corDaLinha: corDaLinha,
  };
}
