# pi-commandcode-provider

A [pi](https://github.com/badlogic/pi-mono) custom provider that connects pi to the [Command Code](https://commandcode.ai) API.

> **Disclaimer:** This is an unofficial, community-maintained package. I am not affiliated with, endorsed by, or connected to Command Code in any way. This provider simply forwards requests to the public Command Code API using your own API key.

> **Note:** This package only provides a model _provider_. It does **not** include an API key. You must bring your own Command Code API key or subscription.

> 💰 **Current offer:** Command Code offers [4× usage of DeepSeek V4](https://commandcode.ai/docs/resources/pricing-limits#deepseek-v4-pro-4x-usage) (Pro and Flash) at no extra cost.

## Models

18 models across premium and open-source providers:

| Category        | Models                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic**   | Claude Opus 4.7, Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5                                                                          |
| **OpenAI**      | GPT-5.5, GPT-5.4, GPT-5.3 Codex, GPT-5.4 Mini                                                                                                  |
| **Open-source** | DeepSeek V4, DeepSeek V4 Pro, DeepSeek V4 Flash, Kimi K2.6, Kimi K2.5, GLM-5.1, GLM-5, MiniMax M2.7, MiniMax M2.5, Qwen 3.6 Max, Qwen 3.6 Plus |

## Install

```sh
pi install npm:pi-commandcode-provider
```

Or shorthand:

```sh
pi install pi-commandcode-provider
```

Then reload pi:

```txt
/reload
```

## Setup

Set your Command Code API key using one of these methods:

### 1. Browser login (recommended)

In pi, run:

```txt
/login
```

Then select **Command Code** from the provider list.

<img width="1520" height="554" alt="image" src="https://github.com/user-attachments/assets/071e929a-6f49-4803-bfec-7a31368fb12a" />

This opens Command Code in your browser and stores the returned API key in pi's auth file. If the browser shows "Copy your API key" because automatic transfer failed, copy that key and paste it into the pi terminal prompt.

> Note: `/login commandcode` is not supported by pi currently; use interactive `/login` and select Command Code.

### 2. Environment variable

```sh
export COMMANDCODE_API_KEY="user_..."
```

### 3. Auth file

Create `~/.commandcode/auth.json`:

```json
{
  "apiKey": "user_..."
}
```

Or use pi's auth file at `~/.pi/agent/auth.json`:

```json
{
  "commandcode": "user_..."
}
```

## Usage

After installing and setting your API key, select a Command Code model in pi:

```txt
/model deepseek/deepseek-v4-flash
```

Any query will then use the Command Code API. You can list available models:

```sh
pi -e index.ts --list-models
```

Or within pi:

```txt
/models
```

## Publish

```sh
npm login
npm publish --access public
```

## License

MIT
