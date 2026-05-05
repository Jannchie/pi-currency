import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

interface CostUsage { input: number; output: number; cost: { total: number }; }
interface CostMsg { role: string; usage: CostUsage; }
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PREFS = join(homedir(), ".pi", "agent", ".currency-pref.json");
const COMMON = ["USD", "CNY", "JPY", "EUR", "GBP", "KRW", "HKD", "TWD", "SGD", "AUD", "CAD"];

let currencies: string[] = [];
let rates: Record<string, number> = {};
let lastFetch = 0;

function load(): string[] {
	try {
		if (!existsSync(PREFS)) return ["CNY"];
		const raw = JSON.parse(readFileSync(PREFS, "utf-8"));
		const arr: string[] = Array.isArray(raw) ? raw : [raw.currency];
		return arr.filter((c) => /^[A-Z]{3}$/.test(c)) || ["CNY"];
	} catch { return ["CNY"]; }
}

function save(currencies: string[]) {
	try {
		const dir = join(homedir(), ".pi", "agent");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(PREFS, JSON.stringify(currencies), "utf-8");
	} catch { /* */ }
}

const fmt = new Map<string, Intl.NumberFormat>();
function fmtr(ccy: string) {
	let f = fmt.get(ccy);
	if (!f) { f = new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, currencyDisplay: "symbol" }); fmt.set(ccy, f); }
	return f;
}

async function refresh() {
	if (Date.now() - lastFetch < 30 * 60 * 1000) return;
	try {
		const r = await fetch("https://open.er-api.com/v6/latest/USD");
		if (!r.ok) return;
		rates = (await r.json()).rates;
		lastFetch = Date.now();
	} catch { /* */ }
}

function fmtn(n: number) {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtc(amt: number, ccy: string) {
	try {
		const f = fmtr(ccy);
		if (amt > 0 && amt < 0.01) return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, currencyDisplay: "symbol", minimumSignificantDigits: 3, maximumSignificantDigits: 3 }).format(amt);
		return f.format(amt);
	} catch { return `${ccy} ${amt.toFixed(4)}`; }
}

export default async function (pi: ExtensionAPI) {
	currencies = load();
	await refresh();
	setInterval(refresh, 30 * 60 * 1000);

	pi.registerCommand("currency", {
		description: `Footer cost currencies (${currencies.join(",")})`,
		getArgumentCompletions: (prefix: string) => {
			const all = [...new Set([...COMMON, ...Object.keys(rates).filter((c) => c !== "USD")])];
			const items = all.map((c) => ({ value: c, label: `${c} (${fmtr(c).format(1)})` }));
			return items.filter((i) => i.value.startsWith(prefix.toUpperCase()));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim().toUpperCase();
			if (!raw) {
				currencies = currencies.length > 1 ? ["USD"] : [COMMON[(COMMON.indexOf(currencies[0]) + 1) % COMMON.length]];
			} else {
				const valid = raw.split(",").map((c) => c.trim()).filter((c) => rates[c] || c === "USD" || c.length === 3);
				if (valid.length !== raw.split(",").filter(Boolean).length) { ctx.ui.notify("Invalid currency code", "error"); return; }
				currencies = [...new Set(valid)];
			}
			save(currencies);
			ctx.ui.notify(currencies.length === 1 && currencies[0] === "USD" ? "USD (no conversion)" : `Cost: ${currencies.join(",")}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() { fmt.clear(); },
				render(width: number): string[] {
					try {
						let inp = 0, out = 0, cost = 0;
						for (const e of ctx.sessionManager.getBranch()) {
							if (e.type === "message" && e.message.role === "assistant") {
								const m = e.message as CostMsg;
								inp += m.usage.input; out += m.usage.output; cost += m.usage.cost.total;
							}
						}
						const dim = (s: string) => theme.fg("dim", s);
						const parts: string[] = [];
						if (cost > 0) {
							for (const ccy of currencies) {
								parts.push(ccy === "USD" ? `$${cost.toFixed(3)}` : rates[ccy] ? fmtc(cost * rates[ccy], ccy) : "");
							}
						}
						const cw = ctx.model?.contextWindow ?? 128000;
						const left = [dim(`↑${fmtn(inp)} ↓${fmtn(out)} R${fmtn(Math.max(0, cw - inp))}`), parts.length ? dim(parts.join(" ")) : "", dim(`${((inp / cw) * 100).toFixed(1)}%/${fmtn(cw)}`)].filter(Boolean).join(" ");
						const right = [Object.values(footerData.getExtensionStatuses()).filter(Boolean).join(" "), "(auto)"].filter(Boolean).join(" ");
						const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
						return [truncateToWidth(left + pad + right, width)];
					} catch { return []; }
				},
			};
		});
	});
}
