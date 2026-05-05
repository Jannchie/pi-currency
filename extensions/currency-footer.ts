/**
 * pi-currency — Real-time currency conversion for the footer cost display.
 *
 * Replaces `$0.030` with converted amounts in one or more currencies.
 *
 * Commands:
 *   /currency             Cycle to next single currency in the common list
 *   /currency CNY         Single currency (shows USD + converted)
 *   /currency USD,JPY     Multiple currencies (USD + converted JPY)
 *   /currency CNY,JPY     Multiple currencies without USD
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, AssistantMessage } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Persistence ──────────────────────────────────────────────────────

const PREFS_FILE = join(homedir(), ".pi", "agent", ".currency-pref.json");

function loadPref(): string[] {
	try {
		if (existsSync(PREFS_FILE)) {
			const raw = readFileSync(PREFS_FILE, "utf-8");
			const data = JSON.parse(raw);
			const arr: string[] = Array.isArray(data) ? data : [data.currency];
			const valid = arr.filter((c: string) => /^[A-Z]{3}$/.test(c));
			if (valid.length > 0) return valid;
		}
	} catch {
		/* corrupt file → fall through */
	}
	return ["CNY"];
}

function savePref(currencies: string[]): void {
	try {
		const dir = join(homedir(), ".pi", "agent");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(PREFS_FILE, JSON.stringify(currencies), "utf-8");
	} catch {
		/* best-effort */
	}
}

// ── Rate fetching ────────────────────────────────────────────────────

let currencies = loadPref();
let usdRates: Record<string, number> = {
	CNY: 7.25, JPY: 151.5, EUR: 0.92, GBP: 0.79, KRW: 1350, HKD: 7.82,
};
let lastFetch = 0;
const FETCH_INTERVAL = 30 * 60 * 1000; // 30 min

const COMMON_CURRENCIES = [
	"USD", "CNY", "JPY", "EUR", "GBP", "KRW", "HKD", "TWD", "SGD", "AUD", "CAD",
];

const formatterCache = new Map<string, Intl.NumberFormat>();

function getFormatter(currency: string): Intl.NumberFormat {
	let f = formatterCache.get(currency);
	if (!f) {
		f = new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
			currencyDisplay: "symbol",
		});
		formatterCache.set(currency, f);
	}
	return f;
}

async function refreshRates(): Promise<void> {
	const now = Date.now();
	if (now - lastFetch < FETCH_INTERVAL) return;
	try {
		const resp = await fetch("https://open.er-api.com/v6/latest/USD");
		if (!resp.ok) return;
		const data = (await resp.json()) as { rates: Record<string, number> };
		usdRates = data.rates;
		lastFetch = now;
	} catch {
		/* keep stale cache */
	}
}

// ── Formatting helpers ───────────────────────────────────────────────

function fmtNum(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtCost(amount: number, currency: string): string {
	try {
		const f = getFormatter(currency);
		if (amount > 0 && amount < 0.01) {
			return new Intl.NumberFormat("en-US", {
				style: "currency",
				currency,
				currencyDisplay: "symbol",
				minimumSignificantDigits: 3,
				maximumSignificantDigits: 3,
			}).format(amount);
		}
		return f.format(amount);
	} catch {
		return `${currency} ${amount.toFixed(4)}`;
	}
}

// ── Shared footer factory (used for every session) ───────────────────

function createFooter(
	theme: ReturnType<Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]>,
	footerData: ReturnType<Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]>,
	ctx: { sessionManager: { getBranch: () => { type: string; message: { role: string; usage: { input: number; output: number; cost: { total: number } } } }[] }; model?: { contextWindow?: number; id?: string } },
) {
	return {
		dispose: () => {},
		invalidate() {
			formatterCache.clear();
		},
		render(width: number): string[] {
			try {
				let input = 0,
					output = 0,
					cost = 0;
				for (const e of ctx.sessionManager.getBranch()) {
					if (e.type === "message" && e.message.role === "assistant") {
						const m = e.message as AssistantMessage;
						input += m.usage.input;
						output += m.usage.output;
						cost += m.usage.cost.total;
					}
				}

				// ── Cost part ──────────────────────────────────
				const parts: string[] = [];
				if (cost > 0) {
					for (const ccy of currencies) {
						if (ccy === "USD") {
							parts.push(`$${cost.toFixed(3)}`);
						} else {
							const rate = usdRates[ccy];
							if (rate) parts.push(fmtCost(cost * rate, ccy));
						}
					}
				}
				const costPart =
					parts.length > 0 ? theme.fg("dim", parts.join(" ")) : "";

				// ── Token stats ────────────────────────────────
				const ctxWindow = ctx.model?.contextWindow ?? 128000;
				const ctxPct =
					ctxWindow > 0
						? ((input / ctxWindow) * 100).toFixed(1)
						: "0.0";
				const remaining = Math.max(0, ctxWindow - input);

				const tokensPart = theme.fg(
					"dim",
					`↑${fmtNum(input)} ↓${fmtNum(output)} R${fmtNum(remaining)}`,
				);
				const ctxPart = theme.fg(
					"dim",
					`${ctxPct}%/${fmtNum(ctxWindow)}`,
				);

				// ── Status & mode ──────────────────────────────
				const statuses = footerData.getExtensionStatuses();
				const statusStr = Object.values(statuses)
					.filter(Boolean)
					.join(" ");
				const statusPart = statusStr
					? theme.fg("dim", statusStr)
					: "";
				const mode = "(auto)";

				const leftStr = [tokensPart, costPart, ctxPart]
					.filter(Boolean)
					.join(" ");
				const rightStr = [statusPart, mode]
					.filter(Boolean)
					.join(" ");

				const pad = " ".repeat(
					Math.max(
						1,
						width - visibleWidth(leftStr) - visibleWidth(rightStr),
					),
				);

				return [truncateToWidth(leftStr + pad + rightStr, width)];
			} catch {
				return [];
			}
		},
	};
}

// ── Extension ────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	await refreshRates();
	setInterval(refreshRates, FETCH_INTERVAL);

	pi.registerCommand("currency", {
		description: `Set footer cost currencies (current: ${currencies.join(",")})`,
		getArgumentCompletions: (prefix: string) => {
			const up = prefix.toUpperCase();
			const all = [
				...COMMON_CURRENCIES,
				...Object.keys(usdRates).filter(
					(c) => c !== "USD" && !COMMON_CURRENCIES.includes(c),
				),
			];
			const items = [...new Set(all)].map((c) => ({
				value: c,
				label: `${c} (${getFormatter(c).format(1)})`,
			}));
			const filtered = items.filter((i) => i.value.startsWith(up));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim().toUpperCase();

			if (!raw) {
				if (currencies.length > 1) {
					currencies = ["USD"];
				} else {
					const idx = COMMON_CURRENCIES.indexOf(currencies[0]);
					currencies = [
						COMMON_CURRENCIES[
							(idx + 1) % COMMON_CURRENCIES.length
						],
					];
				}
			} else {
				const codes = raw
					.split(",")
					.map((c) => c.trim())
					.filter(Boolean);
				const valid: string[] = [];
				for (const code of codes) {
					if (usdRates[code] || code === "USD" || code.length === 3) {
						valid.push(code);
					} else {
						ctx.ui.notify(`Unknown currency: ${code}`, "error");
						return;
					}
				}
				currencies = [...new Set(valid)];
			}

			savePref(currencies);
			const joined = currencies.join(",");
			ctx.ui.notify(
				currencies.length === 1 && currencies[0] === "USD"
					? "Footer cost: USD (no conversion)"
					: `Footer cost: ${joined}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() =>
				tui.requestRender(),
			);
			const footer = createFooter(theme, footerData, ctx);
			return {
				...footer,
				dispose: unsub,
			};
		});

		ctx.ui.notify(
			`pi-currency loaded: ${currencies.join(",")}`,
			"info",
		);
	});
}
