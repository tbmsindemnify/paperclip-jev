---
name: tbm-vault
description: Use on every task. The TBM Knowledge Hub Obsidian vault is the source of truth for TBM Public Adjusters; read it before acting and record results back into it.
---

# TBM Knowledge Hub

The vault at `{{VAULT}}` is the source of truth for TBM Public Adjusters: claims,
carriers, the public-adjusting process, projects, and Tyler's decisions. When the
vault disagrees with anything else (your memory, a web page, an email), the vault
wins unless a newer claim document says otherwise; then name the conflict in the
issue.

## Before acting

- Read the vault's `AGENTS.md` and the `_index.md` of each folder you will touch.
- Find a claim's dossier with
  `cd ~/Documents/ChatGPT/indemnify/pa-agent && .venv/bin/python -m pa_agent.search "<name, address or claim #>"`
  (`--text` searches document text, `--dossier <id>` opens one claim), or start at
  `Claims Index.md`.
- Cite the vault note or document path for every fact you rely on in a comment or draft.

## Writing back

- Claim work goes in that claim's dossier under `claims/`; untriaged material goes
  to `inbox/`. Never edit `Library/`, `system/`, `.obsidian/` or `.trash/`.
- Follow the frontmatter taxonomy in `AGENTS.md`.
- The vault is a git repository. After changing it, commit only the files you
  changed, with the issue identifier in the message:
  `git add <paths> && git commit -m "TBM-12: filed carrier RFI response"`.
  Never rewrite history.

## Outbound actions need Tyler

Nothing leaves TBM without Tyler's approval of that exact item: no sending emails,
no portal submissions, no signatures, no calls. Prepare the draft, put its path in
the issue, and move the issue to `in_review` for Tyler.

Client data may be processed by cloud AI services (Tyler, 2026-10-01). Never
publish it: no public repositories, public links, or posts.
