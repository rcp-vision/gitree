# gitree

`gitree` è un plugin di [Claude Code](https://docs.claude.com/en/docs/claude-code) che mostra, accanto alla chat, lo
stato di tutti i repository git annidati nella cartella della sessione.

L'interfaccia è in italiano.

## Cosa mostra

Il pannello **Repositories** elenca un repository per riga, con tre colonne:

| Colonna | Contenuto |
|---|---|
| **Repo** | Il percorso del repository, a partire dalla cartella che li contiene tutti. |
| **Branch** | Il branch corrente. |
| **Stato** | I pulsanti dei confronti e lo stato rispetto al remote. |

Nella colonna **Stato** compaiono solo i pulsanti che servono:

- **Unstaged N** apre il confronto fra l'indice e la copia di lavoro, file non tracciati compresi.
- **Staged N** apre il confronto fra `HEAD` e l'indice.
- **Da pushare N** apre il confronto fra il punto di partenza dall'upstream e `HEAD`, con l'elenco dei commit.

Accanto ai pulsanti compaiono «senza upstream», «N da pullare» oppure «pulito».

I pulsanti **Fetch**, **Pull** e **Push** eseguono l'azione git sul singolo repository. **Aggiorna** esegue il fetch su
tutti i repository. I repository in lavorazione stanno in cima all'elenco.

Sul desktop il confronto è grafico, in stile Compare Editor di EGit: due lati affiancati, connettori fra i blocchi
cambiati e barre di scorrimento. Sul terminale il confronto mostra le righe cambiate con il contesto.

## Installazione

In Claude Code, aggiungi il marketplace e installa il plugin:

```text
/plugin marketplace add rcp-vision/gitree
/plugin install gitree@rcp-vision
```

Il pannello si apre all'avvio di ogni sessione. Se lo chiudi, lo riapri con `/gitree`.

## Comportamento

- Il plugin cerca i repository nella cartella della sessione fino a 8 livelli di profondità. Salta `node_modules`,
  `.claude`, `.direnv`, `.gradle`, `.venv` e `venv`.
- Lo stato si rilegge ogni 30 secondi, senza fetch. «Da pushare» e «da pullare» si riferiscono all'ultimo fetch.
- Su Linux e macOS fetch, pull e push condividono una connessione SSH per host per 2 minuti, così la passphrase della
  chiave si chiede una volta per host.
- Su Windows i repository si cercano leggendo le cartelle, e un repository trovato non si esplora oltre. Git usa il
  suo ambiente SSH normale.

## Sviluppo

Il codice sta in `hooks/register.tsx` (pannelli e comandi) e `hooks/compare.tsx` (confronto grafico sul desktop). I
tipi dello stato sono in `types/index.d.ts`.

Se vuoi provare una modifica, avvia Claude Code con la cartella del plugin:

```bash
claude --plugin-dir /PERCORSO/DI/gitree
```

Al primo caricamento Claude Code genera i tipi in `.claude-plugin/types/`. Dopo puoi eseguire i controlli:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
npx -p typescript@5 tsc -p .
```

## Licenza

[MIT](LICENSE).
