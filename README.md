# clipEasy

Sistema open source feito pensando nas necessidades básicas de quem edita vídeo e precisa de ferramentas acessíveis e eficientes. Foram utilizados principalmente o **FFmpeg** e o **yt-dlp**, com stack **Node.js** (Fastify + React/Vite), **Supabase** para contas e projetos, e **OpenAI** (Whisper e chat) para legendas e sugestões de metadados do YouTube.

O processamento roda **no seu computador**; a nuvem guarda só login e o JSON da timeline.

## Funcionalidades

- Conta Supabase (ou `DEV_AUTH_BYPASS=1`)
- Projetos **vídeo** e **imagem**
- Timeline estilo CapCut: trim, split, drag, apagar, duplicar, desfazer/refazer, volume, velocidade, fechar buracos
- Preview contínuo entre clipes + pré-visualização do enquadramento 9:16
- Export profissional: 16:9 / 9:16 / ambos, resolução até 4K, FPS, formato MP4/MOV, qualidade, bitrate de áudio, burn-in de legendas
- Vertical: recorte (esquerda / centro / direita / personalizado) ou fundo desfocado
- Editor de foto: crop com pan, brilho/contraste, export JPEG
- Legendas (Whisper) + sugestões de metadados YouTube
- Receitas: split e cortar silêncios

Publicação automática no YouTube **não** está incluída.

## Atalhos do editor

| Tecla | Ação |
|-------|------|
| `Espaço` | Play / pausa |
| `←` `→` | Mover playhead (⇧ = 1s) |
| `↑` `↓` | Frame a frame |
| `⌘/Ctrl` + `←` `→` | Empurrar clipe selecionado |
| `Home` / `End` | Início / fim da timeline |
| `S` | Dividir no playhead |
| `Q` / `W` | Apagar à esquerda / à direita do playhead |
| `D` | Duplicar |
| `M` | Mutar / desmutar |
| `Delete` | Apagar clipe |
| `⇧[` / `⇧]` | Apagar tudo antes / depois do playhead |
| `⌘Z` / `Ctrl+Z` | Desfazer |
| `⇧⌘Z` / `Ctrl+Shift+Z` | Refazer |
| `?` | Lista de atalhos |

## Ferramentas

| Camada | Tecnologias |
|--------|-------------|
| UI | React, TypeScript, Vite |
| API | Node.js, Fastify |
| Mídia | FFmpeg, ffprobe, yt-dlp |
| Conta / DB | Supabase Auth + Postgres |
| IA (opcional) | OpenAI Whisper, GPT-4o-mini |

## Pré-requisitos

```bash
brew install ffmpeg yt-dlp
```

(Sem Homebrew: coloque `ffmpeg`, `ffprobe` e `yt-dlp` no `PATH`, por exemplo em `~/.local/bin`.)

Node.js 20+. Chave OpenAI para legendas e sugestões YouTube.

## Configuração

```bash
cp .env.example .env
```

Preencha:

- `OPENAI_API_KEY`
- `SUPABASE_URL` / keys (ou mantenha `DEV_AUTH_BYPASS=1` e `VITE_DEV_AUTH_BYPASS=1`)
- Rode as migrations em `supabase/migrations/`

## Rodar

```bash
npm install
npm run dev
```

- UI: http://127.0.0.1:5173  
- API: http://127.0.0.1:8787  

## Avisos

- **4K / 1440p** e qualidade máxima aumentam bastante tempo de CPU e tamanho de arquivo
- Whisper e metadados YouTube consomem créditos da OpenAI
- Mídia fica só em `data/projects/` (local); o Supabase guarda conta + JSON do projeto
- Use conteúdo próprio ou autorizado

## Roadmap (ideias)

Thumbnails, capítulos automáticos, intro/outro, presets Shorts, batch long-form→Shorts, biblioteca de mídia, backup zip, loudness −14 LUFS, publicação YouTube OAuth, efeitos/filtros.
