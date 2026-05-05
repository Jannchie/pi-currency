import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

interface CostUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number }; }
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
						const dim = (s: string) => theme.fg("dim", s);

						// --- PWD line: cwd (branch) • sessionName ---
						let pwd = ctx.sessionManager.getCwd();
						const home = process.env.HOME || process.env.USERPROFILE;
						if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
						const branch = footerData.getGitBranch();
						if (branch) pwd = `${pwd} (${branch})`;
						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) pwd = `${pwd} • ${sessionName}`;
						const pwdLine = truncateToWidth(dim(pwd), width, dim("..."));

						// --- Cumulative token/cost stats from ALL entries ---
						let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
						for (const e of ctx.sessionManager.getEntries()) {
							if (e.type === "message" && e.message.role === "assistant") {
								const m = e.message as CostMsg;
								totalInput += m.usage.input;
								totalOutput += m.usage.output;
								totalCacheRead += m.usage.cacheRead ?? 0;
								totalCacheWrite += m.usage.cacheWrite ?? 0;
								totalCost += m.usage.cost.total;
							}
						}

						// --- Context usage ---
						const contextUsage = ctx.getContextUsage();
						const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 128000;
						const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
							? contextUsage.percent.toFixed(1)
							: "?";

						// --- Build stats left side ---
						const statsParts: string[] = [];
						if (totalInput) statsParts.push(`↑${fmtn(totalInput)}`);
						if (totalOutput) statsParts.push(`↓${fmtn(totalOutput)}`);
						if (totalCacheRead) statsParts.push(`R${fmtn(totalCacheRead)}`);
						if (totalCacheWrite) statsParts.push(`W${fmtn(totalCacheWrite)}`);

						// Cost: show USD + converted currencies
						const costParts: string[] = [];
						if (totalCost > 0) {
							costParts.push(`$${totalCost.toFixed(3)}`);
							for (const ccy of currencies) {
								if (ccy !== "USD" && rates[ccy]) costParts.push(fmtc(totalCost * rates[ccy], ccy));
							}
						}
						if (costParts.length) statsParts.push(costParts.join(" "));

						// Context %
						const contextDisplay = contextPercent === "?"
							? `?/${fmtn(contextWindow)} (auto)`
							: `${contextPercent}%/${fmtn(contextWindow)} (auto)`;
						const contextPercentVal = contextUsage?.percent ?? 0;
						const contextStr = contextPercentVal > 90
							? theme.fg("error", contextDisplay)
							: contextPercentVal > 70
								? theme.fg("warning", contextDisplay)
								: contextDisplay;
						statsParts.push(contextStr);

						let statsLeft = statsParts.join(" ");
						let statsLeftWidth = visibleWidth(statsLeft);
						if (statsLeftWidth > width) {
							statsLeft = truncateToWidth(statsLeft, width, "...");
							statsLeftWidth = visibleWidth(statsLeft);
						}

						// --- Extract thinking level from branch entries ---
						let thinkingLevel = "off";
						for (const e of ctx.sessionManager.getBranch()) {
							if (e.type === "thinking_level_change") {
								thinkingLevel = e.thinkingLevel;
							}
						}

						// --- Right side: model + thinking level ---
						const modelName = ctx.model?.id || "no-model";
						let rightSideWithoutProvider = modelName;
						if (ctx.model?.reasoning) {
							rightSideWithoutProvider = thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
						}

						let rightSide = rightSideWithoutProvider;
						if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
							rightSide = `(${ctx.model!.provider}) ${rightSideWithoutProvider}`;
							if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
								rightSide = rightSideWithoutProvider;
							}
						}

						const minPadding = 2;
						const rightSideWidth = visibleWidth(rightSide);
						const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

						let statsLine: string;
						if (totalNeeded <= width) {
							const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
							statsLine = statsLeft + padding + rightSide;
						} else {
							const availableForRight = width - statsLeftWidth - minPadding;
							if (availableForRight > 0) {
								const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
								const pad = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
								statsLine = statsLeft + pad + truncatedRight;
							} else {
								statsLine = statsLeft;
							}
						}

						// Dim each part separately (statsLeft may contain colored context %)
						const dimStatsLeft = dim(statsLeft);
						const remainder = statsLine.slice(statsLeft.length);
						const dimRemainder = dim(remainder);

						const lines = [pwdLine, dimStatsLeft + dimRemainder];

						// --- Extension statuses ---
						const extensionStatuses = footerData.getExtensionStatuses();
						if (extensionStatuses.size > 0) {
							const statusTexts = Array.from(extensionStatuses.entries())
								.sort(([a], [b]) => a.localeCompare(b))
								.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
							lines.push(truncateToWidth(statusTexts.join(" "), width, dim("...")));
						}

						return lines;
					} catch { return []; }
				},
			};
		});
	});
}
