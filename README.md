# candidaturas-drive

Google Apps Script que organiza candidaturas de emprego registradas numa planilha Google.

A partir de uma aba "livre", preenchida à mão, o script mantém três abas sincronizadas:

| Aba | Conteúdo |
| --- | --- |
| **Candidaturas** | Uma linha por candidatura: etapa atual, datas, próxima etapa, status e dias parado. As colunas `Status (manual)`, `Próximo passo ✍️` e `Notas ✍️` são suas e o script as preserva. |
| **Painel** | Totais, contagem por status, funil por etapa (com gráfico) e candidaturas paradas há mais de 14 dias. |
| **Agenda** | Entrevistas dos últimos 7 dias e dos próximos 30, com hoje e amanhã destacados. |

Além disso, envia **um e-mail por dia por volta das 6h** com as entrevistas de hoje e de amanhã e as candidaturas paradas. Se não houver nada, o e-mail não é enviado.

A aba de origem **nunca é alterada**.

## Como a aba de origem é lida

Colunas encontradas pelo cabeçalho: `Empresa | Data | Horario | Cargo | RH | link da reunião`. Tudo o que vem depois de `link da reunião` são as etapas seguintes, lidas em **trios `Data | Hora | Link`**, da esquerda para a direita:

- cada trio preenchido vira Etapa 2, 3, 4...;
- um trio que não começa com data (por exemplo, "concluído o teste técnico") vira **nota** da etapa;
- datas sem ano (`01/09`) contam como 2026; horários aceitos: `14:00`, `10h`, `9:30h`, `5pm – 5:40pm`.

Cada candidatura é identificada por **Empresa + Cargo**, sem diferenciar maiúsculas, acentos ou espaços. Se uma candidatura sumir da origem, ela continua na aba Candidaturas marcada como `Removida da origem`.

### Status

| Status | Origem |
| --- | --- |
| `Agendado` | automático: há etapa com data futura |
| `Aguardando retorno` | automático: última etapa há 14 dias ou menos |
| `Sem resposta` | automático: última etapa há mais de 14 dias |
| `Reprovado`, `Desisti`, `Oferta`, `Contratado` | manual, pela coluna `Status (manual)` |

O status manual sempre tem prioridade. `Reprovado`, `Desisti` e `Contratado` contam como encerradas e saem da Agenda e dos alertas.

## Arquitetura

```
src/Core.js    regras puras (leitura, status, painel, agenda, e-mail), sem APIs do Google
src/Main.js    ponte com a planilha: menu, gatilhos, escrita das abas, MailApp
test/          testes do Core com node --test
```

O `Core.js` não usa nenhuma API do Apps Script, então roda igual no Node e no Google. O mesmo arquivo é enviado ao Apps Script pelo [clasp](https://github.com/google/clasp) e testado no CI.

## Instalação

Requisitos: Node 22+ e a conta Google **dona** da planilha.

1. Ative a Apps Script API em <https://script.google.com/home/usersettings>.
2. Instale e autentique o clasp:
   ```sh
   npm install -g @google/clasp
   clasp login
   ```
3. Crie o projeto Apps Script vinculado à planilha, usando o ID que aparece na URL dela:
   ```sh
   clasp create-script --parentId <ID_DA_PLANILHA> --rootDir src --title candidaturas
   clasp push
   ```
4. Abra a planilha e recarregue a página. No menu **Candidaturas**:
   - **Instalar gatilhos**: na primeira vez, o Google pede permissão. Esse item cria a sincronização de hora em hora e o e-mail diário, e já roda uma sincronização.
   - **Sincronizar** / **Enviar resumo agora**: execução manual.

Por padrão, o e-mail vai para a conta que instalou os gatilhos. Para mudar o destino, crie a propriedade `EMAIL_DESTINO` em *Configurações do projeto → Propriedades do script*.

## Desenvolvimento

```sh
npm test      # testes do Core (fuso America/Sao_Paulo)
clasp push    # envia src/ para o Apps Script
```

## Licença

MIT
