# pi-currency

Real-time currency conversion for the pi TUI footer cost display.

Converts `$0.030` to your preferred currency — live, in your footer.

```bash
pi install npm:pi-currency
```

## Features

- **Live conversion** — pi footer cost is shown in your chosen currency
- **Cycle or pick** — rotate through currencies or set specific ones
- **Sticks around** — preference is saved automatically

## Usage

| Command | What it does |
|---------|--------------|
| `/currency` | Cycle to next currency |
| `/currency JPY` | Show only JPY |
| `/currency USD,CNY,JPY` | Show multiple at once |
| `/currency USD` | Reset to default (USD) |

Supports any [ISO 4217](https://en.wikipedia.org/wiki/ISO_4217) currency code.

```
↑121k ↓23k R2.4M $0.030 CN¥0.22 7.4%/1.0M (auto)
```

Data from [open.er-api.com](https://open.er-api.com) — free, cached 30 minutes.
