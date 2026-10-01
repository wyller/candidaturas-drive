/**
 * Ponte entre a planilha e as regras de Core.js.
 *
 * Lê a aba de origem (só leitura), grava as abas Candidaturas, Painel e Agenda,
 * e envia o resumo diário por e-mail.
 */

var ABA_ORIGEM = 'Entrevista Apos Vetta';
var ABA_CANDIDATURAS = 'Candidaturas';
var ABA_PAINEL = 'Painel';
var ABA_AGENDA = 'Agenda';
var ANO_PADRAO = 2026;
var FORMATO_DATA_HORA = 'dd/MM/yyyy HH:mm';
var HORA_EMAIL = 6;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Candidaturas')
    .addItem('Sincronizar', 'sincronizarPeloMenu')
    .addItem('Enviar resumo agora', 'enviarResumoPeloMenu')
    .addSeparator()
    .addItem('Instalar gatilhos', 'instalarGatilhos')
    .addToUi();
}

/**
 * Mantém "Status final" em dia quando você edita "Status (manual)", sem
 * esperar a próxima sincronização. (Fórmula ali dava #ERROR! na planilha.)
 */
function onEdit(e) {
  var aba = e.range.getSheet();
  if (aba.getName() !== ABA_CANDIDATURAS) return;
  var colAuto = COLUNAS_CANDIDATURAS.indexOf('Status (auto)') + 1;
  var colManual = COLUNAS_CANDIDATURAS.indexOf('Status (manual)') + 1;
  if (e.range.getColumn() > colManual || e.range.getLastColumn() < colManual) return;

  var primeira = Math.max(e.range.getRow(), 2);
  var n = e.range.getLastRow() - primeira + 1;
  if (n < 1) return;
  // Status (auto), Status (manual) e Status final são colunas vizinhas.
  var faixa = aba.getRange(primeira, colAuto, n, 3);
  var finais = faixa.getValues().map(function (l) { return [statusFinal(l[0], l[1])]; });
  aba.getRange(primeira, colAuto + 2, n, 1).setValues(finais);

  var largura = COLUNAS_CANDIDATURAS.length;
  var colEtapa = COLUNAS_CANDIDATURAS.indexOf('Etapa atual') + 1;
  var etapas = aba.getRange(primeira, colEtapa, n, 1).getValues();
  aba.getRange(primeira, 1, n, largura).setBackgrounds(finais.map(function (f, k) {
    var cor = corDaLinha(f[0], etapas[k][0]);
    var linha = [];
    for (var c = 0; c < largura; c++) linha.push(cor);
    return linha;
  }));
}

function sincronizarPeloMenu() {
  var r = sincronizar();
  SpreadsheetApp.getActive().toast(r.total + ' candidaturas sincronizadas.', 'Candidaturas', 5);
}

function enviarResumoPeloMenu() {
  var enviado = enviarResumoDiario();
  SpreadsheetApp.getActive().toast(
    enviado ? 'Resumo enviado para ' + destinatario() + '.' : 'Nada para hoje/amanhã nem paradas: e-mail não enviado.',
    'Candidaturas', 5);
}

/** Chamado pelo menu e pelo gatilho de hora em hora. */
function sincronizar() {
  return comTrava(function () {
    var dados = calcular();
    var ss = SpreadsheetApp.getActive();
    escreverCandidaturas(ss, dados.linhas);
    escreverPainel(ss, montarPainel(dados.candidaturas, dados.status), dados.agora);
    escreverAgenda(ss, montarAgenda(dados.candidaturas, dados.status, dados.agora));
    return { total: dados.candidaturas.length };
  });
}

/** Chamado pelo gatilho diário. Sincroniza antes, para mandar dados frescos. */
function enviarResumoDiario() {
  sincronizar();
  var dados = calcular();
  var resumo = montarResumoDiario(dados.candidaturas, dados.status, dados.agora, formatarData);
  if (!resumo) return false;
  MailApp.sendEmail({
    to: destinatario(),
    subject: resumo.assunto,
    body: resumo.corpo + '\n\nPlanilha: ' + SpreadsheetApp.getActive().getUrl(),
  });
  return true;
}

/** Recria os gatilhos deste projeto (apaga os antigos para não duplicar). */
function instalarGatilhos() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sincronizar').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('enviarResumoDiario').timeBased()
    .everyDays(1).atHour(HORA_EMAIL).nearMinute(0).inTimezone(Session.getScriptTimeZone()).create();
  sincronizar();
  SpreadsheetApp.getActive().toast(
    'Sincronização de hora em hora e e-mail diário por volta das ' + HORA_EMAIL + 'h instalados.', 'Candidaturas', 8);
}

function calcular() {
  var ss = SpreadsheetApp.getActive();
  var origem = ss.getSheetByName(ABA_ORIGEM);
  if (!origem) throw new Error('Aba "' + ABA_ORIGEM + '" não encontrada. Nada foi alterado.');

  var agora = new Date();
  var faixa = origem.getDataRange();
  var candidaturas = lerCandidaturas(faixa.getDisplayValues(), ANO_PADRAO, agora, faixa.getBackgrounds());
  var abaCand = ss.getSheetByName(ABA_CANDIDATURAS);
  var anteriores = abaCand && abaCand.getLastRow() > 0 ? abaCand.getDataRange().getValues() : [];
  var mescla = mesclarComAnteriores(candidaturas, anteriores);

  return { agora: agora, candidaturas: candidaturas, linhas: mescla.linhas, status: mescla.status };
}

function escreverCandidaturas(ss, linhas) {
  var aba = obterAba(ss, ABA_CANDIDATURAS);
  var cols = COLUNAS_CANDIDATURAS;
  var idx = {};
  cols.forEach(function (nome, i) { idx[nome] = i + 1; });

  aba.clearContents();
  aba.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  aba.setFrozenRows(1);
  if (!linhas.length) return;

  var n = linhas.length;
  aba.getRange(2, 1, n, cols.length).setValues(linhas);
  aba.getRange(2, 1, n, cols.length).setBackgrounds(linhas.map(function (l) {
    var cor = corDaLinha(l[idx['Status final'] - 1], l[idx['Etapa atual'] - 1]);
    return cols.map(function () { return cor; });
  }));

  ['1ª conversa', 'Data última etapa', 'Próxima etapa'].forEach(function (nome) {
    aba.getRange(2, idx[nome], n, 1).setNumberFormat(FORMATO_DATA_HORA);
  });
  aba.getRange(2, idx['Status (manual)'], n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUS_MANUAIS, true).setAllowInvalid(false).build());
  limparSobras(aba, n + 1, cols.length);
  aba.autoResizeColumns(1, cols.length);
}

function escreverPainel(ss, painel, agora) {
  var aba = obterAba(ss, ABA_PAINEL);
  aba.clear();
  aba.getCharts().forEach(function (g) { aba.removeChart(g); });

  var linha = 1;
  aba.getRange(linha, 1).setValue('Última sincronização: ' + formatarData(agora)).setFontStyle('italic');
  linha += 2;

  linha = escreverBloco(aba, linha, 'Resumo', ['', 'Qtde'], painel.totais);
  linha = escreverBloco(aba, linha, 'Por status', ['Status', 'Qtde'], painel.porStatus);
  var inicioFunil = linha + 1;
  linha = escreverBloco(aba, linha, 'Funil por etapa', ['Etapa', 'Candidaturas'], painel.funil);
  linha = escreverBloco(aba, linha, 'Paradas há mais de ' + DIAS_SEM_RESPOSTA + ' dias',
    ['Empresa', 'Cargo', 'Etapa atual', 'Última etapa', 'Dias'], painel.paradas);

  if (painel.funil.length) {
    aba.insertChart(aba.newChart()
      .asBarChart()
      .addRange(aba.getRange(inicioFunil, 1, painel.funil.length + 1, 2))
      .setNumHeaders(1)
      .setOption('title', 'Funil por etapa')
      .setOption('legend', { position: 'none' })
      .setPosition(1, 7, 0, 0)
      .build());
  }
  aba.autoResizeColumns(1, 5);
}

/** Título + cabeçalho + linhas; devolve a próxima linha livre (com uma em branco). */
function escreverBloco(aba, linha, titulo, cabecalho, valores) {
  aba.getRange(linha, 1).setValue(titulo).setFontWeight('bold').setFontSize(12);
  aba.getRange(linha + 1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
  if (valores.length) {
    var largura = cabecalho.length;
    var normalizados = valores.map(function (v) {
      var l = v.map(function (x) { return x == null ? '' : x; });
      while (l.length < largura) l.push('');
      return l.slice(0, largura);
    });
    aba.getRange(linha + 2, 1, normalizados.length, largura).setValues(normalizados);
    normalizados[0].forEach(function (x, c) {
      if (x instanceof Date) aba.getRange(linha + 2, c + 1, normalizados.length, 1).setNumberFormat(FORMATO_DATA_HORA);
    });
  } else {
    aba.getRange(linha + 2, 1).setValue('—');
  }
  return linha + 2 + Math.max(valores.length, 1) + 1;
}

function escreverAgenda(ss, itens) {
  var aba = obterAba(ss, ABA_AGENDA);
  var cab = ['Data/hora', 'Quando', 'Empresa', 'Cargo', 'Etapa', 'Link', 'Status'];
  aba.clear();
  aba.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold');
  aba.setFrozenRows(1);
  if (!itens.length) {
    aba.getRange(2, 1).setValue('Nenhuma entrevista nos últimos 7 dias nem nos próximos 30.');
    return;
  }
  var hoje = new Date();
  var linhas = itens.map(function (i) {
    return [i.data, quando(i.data, hoje), i.empresa, i.cargo, i.etapa, i.link, i.status];
  });
  aba.getRange(2, 1, linhas.length, cab.length).setValues(linhas);
  aba.getRange(2, 1, linhas.length, 1).setNumberFormat(FORMATO_DATA_HORA);
  linhas.forEach(function (l, k) {
    if (l[1] === 'Hoje' || l[1] === 'Amanhã') aba.getRange(k + 2, 1, 1, cab.length).setBackground('#cfe2f3');
    else if (l[0] < hoje) aba.getRange(k + 2, 1, 1, cab.length).setFontColor('#888888');
  });
  aba.autoResizeColumns(1, cab.length);
}

function quando(data, hoje) {
  var dias = diasEntre(hoje, data);
  if (dias === 0) return 'Hoje';
  if (dias === 1) return 'Amanhã';
  if (dias === -1) return 'Ontem';
  return dias > 0 ? 'Em ' + dias + ' dias' : 'Há ' + -dias + ' dias';
}

function obterAba(ss, nome) {
  return ss.getSheetByName(nome) || ss.insertSheet(nome);
}

/** Remove linhas antigas que sobraram abaixo da tabela. */
function limparSobras(aba, ultimaLinha, largura) {
  var max = aba.getMaxRows();
  if (max > ultimaLinha) {
    var resto = aba.getRange(ultimaLinha + 1, 1, max - ultimaLinha, largura);
    resto.clearContent().clearDataValidations().setBackground(null);
  }
}

function formatarData(data) {
  return Utilities.formatDate(data, Session.getScriptTimeZone(), FORMATO_DATA_HORA);
}

/** Destino do e-mail: propriedade EMAIL_DESTINO do script, ou o dono da execução. */
function destinatario() {
  return PropertiesService.getScriptProperties().getProperty('EMAIL_DESTINO') ||
    Session.getEffectiveUser().getEmail();
}

function comTrava(fn) {
  var trava = LockService.getScriptLock();
  trava.waitLock(30 * 1000);
  try {
    return fn();
  } finally {
    trava.releaseLock();
  }
}
