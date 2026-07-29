# ClipFácil

Editor **local** para criar conteúdo de YouTube: vídeo (timeline multi-trilha) e foto (crop 16:9 ↔ 9:16), com conta Supabase, legendas Whisper e sugestões de título/descrição/tags.

## Funcionalidades

- Conta Supabase (ou `DEV_AUTH_BYPASS=1`)
- Projetos **vídeo** e **imagem**
- Timeline: vídeo / áudio / legendas — trim, split, drag, transições
- Export de vídeo: 720p, **1080p, 1440p, 4K (2160p)** — horizontal e vertical
- Editor de foto: crop com pan (centro por padrão), brilho/contraste, export JPEG
- Legendas (Whisper) + burn-in
- **Metadados YouTube** a partir das legendas (títulos, descrição, hashtags, tags)
- Receitas: split e cortar silêncios

Publicação automática no YouTube **não** está incluída.

## Pré-requisitos

```bash
brew install ffmpeg yt-dlp
```

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

- **4K / 1440p** aumentam bastante tempo de CPU e tamanho de arquivo no seu PC
- Whisper e metadados YouTube consomem créditos da OpenAI
- Mídia fica só em `data/projects/` (local); o Supabase guarda conta + JSON do projeto
- Use conteúdo próprio ou autorizado

## Roadmap (ideias)

Thumbnails, capítulos automáticos, intro/outro, presets Shorts, batch long-form→Shorts, biblioteca de mídia, backup zip, loudness −14 LUFS, publicação YouTube OAuth.
