const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/Core.js');

const CABECALHO = ['Empresa', 'Data', 'Horario', 'Cargo', 'RH', 'link da reunião',
  'Fase 2', '', '', '', '', '', '', '', '', '', 'Fase 3', '', '', '', ''];

function linha(campos, fases = []) {
  const l = [campos.empresa || '', campos.data || '', campos.hora || '', campos.cargo || '',
    campos.rh || '', campos.link || ''];
  const f = fases.slice();
  while (f.length < 15) f.push('');
  return l.concat(f);
}

const AGORA = new Date(2026, 9, 1, 9, 0); // 01/10/2026 09:00

test('lerData aceita dd/mm, dd/mm/aaaa e dd/mm/aa', () => {
  assert.deepEqual(core.lerData('01/09', 2026), { y: 2026, m: 9, d: 1 });
  assert.deepEqual(core.lerData(' 16/09/2026 ', 2026), { y: 2026, m: 9, d: 16 });
  assert.deepEqual(core.lerData('5/10/25', 2026), { y: 2025, m: 10, d: 5 });
  assert.equal(core.lerData('concluido o projeto', 2026), null);
  assert.equal(core.lerData('32/01', 2026), null);
  assert.equal(core.lerData('', 2026), null);
});

test('lerHora entende os formatos usados na planilha', () => {
  assert.deepEqual(core.lerHora('12:25'), { h: 12, min: 25 });
  assert.deepEqual(core.lerHora('10h'), { h: 10, min: 0 });
  assert.deepEqual(core.lerHora('9:30h'), { h: 9, min: 30 });
  assert.deepEqual(core.lerHora('5pm – 5:40pm (BRT)'), { h: 17, min: 0 });
  assert.equal(core.lerHora('a combinar'), null);
});

test('lerEtapas lê trios em sequência e transforma texto livre em nota', () => {
  const etapas = core.lerEtapas([
    'feito o teste técnico', 'https://github.com/exemplo/teste', '',
    '', '', '',
    '29/09', '14:00', 'https://meet.google.com/abc',
  ], 2026);
  assert.equal(etapas.length, 2);
  assert.equal(etapas[0].numero, 2);
  assert.equal(etapas[0].data, null);
  assert.equal(etapas[0].nota, 'feito o teste técnico');
  assert.equal(etapas[0].link, 'https://github.com/exemplo/teste');
  assert.equal(etapas[1].numero, 3);
  assert.deepEqual(etapas[1].data, new Date(2026, 8, 29, 14, 0));
});

test('chave ignora maiúsculas, acentos e espaços', () => {
  assert.equal(core.chaveCandidatura(' Acme  ', 'Engenheiro DevOps'),
    core.chaveCandidatura('acme', 'engenheiro devops'));
  assert.equal(core.chaveCandidatura('Ação', 'SRE'), core.chaveCandidatura('acao', 'sre'));
});

function fixture() {
  return [
    CABECALHO,
    linha({ empresa: 'Agendada', data: '21/09', hora: '09:15', cargo: 'DevOps' },
      ['29/09', '14:00', 'link2', '02/10', '13:00', 'link3']),
    linha({ empresa: 'Recente', data: '24/09', hora: '17:00', cargo: 'SRE' }),
    linha({ empresa: 'Antiga', data: '01/09', hora: '12:25' }),
    linha({ empresa: 'Teste', cargo: 'DevOps' }, ['concluído o teste técnico', 'https://github.com/x/y']),
    linha({ empresa: '' }),
    linha({ empresa: 'Antiga', data: '05/09', hora: '10h' }),
  ];
}

test('lerCandidaturas calcula etapa atual, próxima etapa e status automático', () => {
  const cs = core.lerCandidaturas(fixture(), 2026, AGORA);
  const por = Object.fromEntries(cs.map(c => [c.chave, c]));

  assert.equal(cs.length, 5, 'linha sem empresa é ignorada');

  const ag = por['agendada|devops'];
  assert.equal(ag.statusAuto, core.STATUS.AGENDADO);
  assert.equal(ag.etapaAtual, 'Etapa 3');
  assert.deepEqual(ag.proximaEtapa, new Date(2026, 9, 2, 13, 0));
  assert.deepEqual(ag.dataUltimaEtapa, new Date(2026, 8, 29, 14, 0));
  assert.equal(ag.diasParado, null);

  assert.equal(por['recente|sre'].statusAuto, core.STATUS.AGUARDANDO);
  assert.equal(por['recente|sre'].diasParado, 7);

  assert.equal(por['antiga|'].statusAuto, core.STATUS.SEM_RESPOSTA);
  assert.equal(por['antiga|'].diasParado, 30);
  assert.ok(por['antiga|#2'], 'empresa+cargo repetidos ganham sufixo');

  const t = por['teste|devops'];
  assert.equal(t.etapaAtual, 'Etapa 2 — concluído o teste técnico');
  assert.equal(t.linkUltimaEtapa, 'https://github.com/x/y');
  assert.equal(t.statusAuto, core.STATUS.AGUARDANDO);
});

test('lerCandidaturas falha com mensagem clara se faltar coluna', () => {
  assert.throws(() => core.lerCandidaturas([['Empresa', 'Data']], 2026, AGORA), /horario/);
});

test('mesclarComAnteriores preserva colunas manuais e marca removidas', () => {
  const cols = core.COLUNAS_CANDIDATURAS;
  const i = Object.fromEntries(cols.map((n, k) => [n, k]));
  const cs = core.lerCandidaturas(fixture(), 2026, AGORA);

  const primeira = core.mesclarComAnteriores(cs, []);
  const anteriores = [cols].concat(primeira.linhas.map(l => l.slice()));
  const recente = anteriores.find(l => l[i['Empresa']] === 'Recente');
  recente[i['Status (manual)']] = core.STATUS.REPROVADO;
  recente[i['Notas ✍️']] = 'feedback por e-mail';
  const sumiu = cols.map(() => '');
  sumiu[i['Empresa']] = 'Sumiu';
  sumiu[i['Próximo passo ✍️']] = 'mandar mensagem';
  anteriores.push(sumiu);

  const { linhas, status } = core.mesclarComAnteriores(cs, anteriores);
  const r = linhas.find(l => l[i['Empresa']] === 'Recente');
  assert.equal(r[i['Status (manual)']], core.STATUS.REPROVADO);
  assert.equal(r[i['Status final']], core.STATUS.REPROVADO);
  assert.equal(r[i['Notas ✍️']], 'feedback por e-mail');
  assert.equal(status['recente|sre'], core.STATUS.REPROVADO);

  const s = linhas.find(l => l[i['Empresa']] === 'Sumiu');
  assert.equal(s[i['Status (auto)']], core.STATUS.REMOVIDA);
  assert.equal(s[i['Próximo passo ✍️']], 'mandar mensagem');

  const ordem = linhas.map(l => l[i['Empresa']]);
  assert.equal(ordem[0], 'Agendada', 'ativa com próxima etapa vem primeiro');
  assert.equal(ordem[ordem.length - 1], 'Recente', 'encerrada vai para o fim');
  assert.equal(ordem[ordem.length - 2], 'Sumiu', 'removida fica antes das encerradas');
});

test('montarPainel conta status, funil e paradas', () => {
  const cs = core.lerCandidaturas(fixture(), 2026, AGORA);
  const { status } = core.mesclarComAnteriores(cs, []);
  const p = core.montarPainel(cs, status);

  assert.deepEqual(p.totais, [['Ativas', 5], ['Encerradas', 0], ['Ofertas', 0]]);
  assert.deepEqual(p.funil, [['1ª conversa', 5], ['Etapa 2', 2], ['Etapa 3', 1]]);
  assert.deepEqual(p.paradas.map(x => x[0]), ['Antiga', 'Antiga']);
  assert.ok(p.porStatus.some(([s, n]) => s === core.STATUS.SEM_RESPOSTA && n === 2));
});

test('montarAgenda cobre 7 dias atrás até 30 dias à frente e pula encerradas', () => {
  const cs = core.lerCandidaturas(fixture(), 2026, AGORA);
  const { status } = core.mesclarComAnteriores(cs, []);
  const empresas = core.montarAgenda(cs, status, AGORA).map(x => x.empresa + ' ' + x.etapa);
  assert.deepEqual(empresas, ['Recente 1ª conversa', 'Agendada Etapa 2', 'Agendada Etapa 3']);

  status['recente|sre'] = core.STATUS.DESISTI;
  assert.ok(!core.montarAgenda(cs, status, AGORA).some(x => x.empresa === 'Recente'));
});

test('montarResumoDiario lista hoje/amanhã e paradas; null quando vazio', () => {
  const cs = core.lerCandidaturas(fixture(), 2026, AGORA);
  const { status } = core.mesclarComAnteriores(cs, []);
  const fmt = d => d.toISOString();
  const r = core.montarResumoDiario(cs, status, AGORA, fmt);
  assert.match(r.assunto, /1 entrevista\(s\) hoje\/amanhã, 2 parada\(s\)/);
  assert.match(r.corpo, /Agendada \(DevOps\) — Etapa 3/);

  const vazio = core.lerCandidaturas([CABECALHO], 2026, AGORA);
  assert.equal(core.montarResumoDiario(vazio, {}, AGORA, fmt), null);
});
