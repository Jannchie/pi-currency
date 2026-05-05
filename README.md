# pi-currency

A [pi](https://pi.dev) extension that converts the TUI footer cost display
from USD to any currency using real-time exchange rates.

## Install

```bash
pi install ~/pi-currency
```

Or try without installing:

```bash
pi -e ~/pi-currency
```

## Usage

Once loaded, the footer changes from:

```
↑121k ↓23k R2.4M $0.030 7.4%/1.0M (auto)
```

to (for example):

```
↑121k ↓23k R2.4M $0.030 CN¥0.22 7.4%/1.0M (auto)
```

### Commands

| Command | Effect |
|---------|--------|
| `/currency` | Cycle to next single currency in the common list |
| `/currency CNY` | Show USD + converted CNY |
| `/currency JPY` | Show USD + converted JPY |
| `/currency USD` | Back to plain USD (no conversion) |
| `/currency CNY,JPY` | Show both, hide USD |
| `/currency USD,CNY,JPY` | Show USD + both conversions |
| `/currency KRW` | Show USD + converted KRW |

Supports any [ISO 4217](https://en.wikipedia.org/wiki/ISO_4217) currency code.

### Persistence

Your currency preference is saved to `~/.pi/agent/.currency-pref.json`
and restored automatically on restart.

## Data source

Exchange rates are fetched from [open.er-api.com](https://open.er-api.com)
(free, no API key required) and cached for 30 minutes.
