import React, { useState, useEffect, useMemo, useRef } from "react";
import { Download, ChevronRight, ChevronLeft, RotateCcw, Flame, Target, Loader2, Check, X, BarChart3, Shuffle, ListChecks, Sparkles, TrendingUp, TrendingDown, SlidersHorizontal } from "lucide-react";

// ---------------------------------------------------------------------------
// Topic framework — Americas split into Ecology / Agriculture
// ---------------------------------------------------------------------------
const TOPICS = [
  { id: "dogs",    label: "Dog Breeds",   pillar: "Nature",    hint: "breed characteristics, temperament, history, working roles, grooming needs, and health traits" },
  { id: "spanish", label: "Spanish",      pillar: "Language",  hint: "vocabulary, grammar, verb conjugation, reading comprehension, and everyday conversation" },
  { id: "python",  label: "Python",       pillar: "Tech",      hint: "syntax, data structures, OOP, standard library, common patterns, and debugging" },
  { id: "anatomy", label: "Anatomy",      pillar: "Science",   hint: "body systems, organs, tissues, physiology, and medical terminology" },
  { id: "repair",  label: "Home Repair",  pillar: "Practical", hint: "plumbing basics, electrical safety, drywall, painting, carpentry, HVAC, and tool use" },
];

const PILLAR_COLORS = {
  Nature:   "#84cc16",
  Language: "#a78bfa",
  Tech:     "#60a5fa",
  Science:  "#f59e0b",
  Practical:"#f97316",
  Custom:   "#888888",
};

// Score labels — shown on result screen and used in the grading rubric
const SCORE_LABELS = {
  1: "No clue",
  2: "Domain knowledge, wrong on the assessment",
  3: "Right concept — unclear or incomplete",
  4: "Mostly right and clear, minor gap",
  5: "Correct and complete",
};

const STORAGE_KEY = "vd_learning_history_v1";
const DELETED_TOPICS_KEY = "vd_deleted_topics_v1";
const CUSTOM_TOPICS_KEY = "vd_custom_topics_v1";

// Update this to your deployed portfolio URL before publishing.
const PORTFOLIO_URL = "/";

const MODEL = "claude-sonnet-4-20250514";
const API_URL = "/api/chat";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
let memFallback = [];
async function loadHistory() {
  try {
    const res = await fetch(`/api/storage?key=${encodeURIComponent(STORAGE_KEY)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.value) return JSON.parse(data.value);
    }
  } catch { /* fall through */ }
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) return JSON.parse(v);
  } catch { /* fall through */ }
  return memFallback;
}
async function saveHistory(history) {
  memFallback = history;
  const payload = JSON.stringify(history);
  try { localStorage.setItem(STORAGE_KEY, payload); } catch { /* ignore */ }
  try {
    await fetch(`/api/storage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: STORAGE_KEY, value: payload }),
    });
  } catch { /* offline */ }
}

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------
function extractText(data) {
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function parseJson(text) {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(s, e + 1));
}
async function generateQuestion(topic, recentQs) {
  const avoid = recentQs.length
    ? `Do NOT repeat or closely paraphrase any of these recently-asked questions:\n- ${recentQs.join("\n- ")}`
    : "";
  const prompt = `Generate ONE challenging but fair question for a self-study learner on this topic:
TOPIC: ${topic.label}
SCOPE: ${topic.hint}

Rules:
- Test applied, working understanding — not trivia or definitions.
- ONE question only. Single part. One correct answer. No compound questions ("what, and why, and how"). No lists. Answerable in 1-3 sentences.
- Stay strictly within the topic and scope above. Do not import context from any other domain.
${avoid}

Respond ONLY with JSON, no markdown, no preamble:
{"question": "..."}`;
  const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" },

    body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: "user", content: prompt }] }) });
  if (!res.ok) { const t = await res.text(); throw new Error(`Worker ${res.status}: ${t}`); }
  const data = await res.json();
  return parseJson(extractText(data)).question;
}

async function scoreAnswer(topic, question, answer) {
  const prompt = `You are a fair but rigorous grader assessing conceptual understanding for a self-study learner.

TOPIC: ${topic.label}
QUESTION: ${question}
LEARNER'S ANSWER: ${answer || "(no answer given)"}

Rubric (1-5):
1 = Truly no clue — no relevant knowledge demonstrated
2 = Has some subject-matter understanding but was wrong in their assessment or conclusion
3 = Subject-matter understanding and was right, but not clear or complete in the response
4 = Subject-matter understanding, mostly right and clear, but had a minor error or left something incomplete
5 = Subject-matter understanding, completely correct and clear

Do NOT penalize for imprecise wording if the underlying concept is correct.
Do NOT require textbook completeness for a 4 — practical working knowledge is enough.
Reserve 1-2 for genuine misunderstanding or wrong conclusions, not just incomplete answers.

Respond ONLY with JSON, no markdown:
{"score": <1-5 integer>, "rationale": "1-2 sentences naming exactly what was right and what was missing or wrong"}`;
  const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: "user", content: prompt }] }) });
  const data = await res.json();
  const out = parseJson(extractText(data));
  return { score: Math.max(1, Math.min(5, Math.round(out.score))), rationale: out.rationale };
}

async function generateValidation(topic, question, answer, score, rationale) {
  const prompt = `Topic: ${topic.label}
Question: ${question}
Learner's Answer: ${answer}
Your Score: ${score}/5
Your Feedback: ${rationale}

Begin with a concise correct answer on its own line, prefixed exactly "Correct answer: ...". Then 1-2 sentences analyzing what the learner got right or wrong. Be direct. No preamble.`;
  const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: "user", content: prompt }] }) });
  const data = await res.json();
  return extractText(data).trim();
}

async function synthesizeSummary(stats, topicList) {
  const rows = topicList.map((t) => {
    const s = stats[t.id];
    return `${t.label}: ${s?.count ? s.avg.toFixed(1) + "/5 over " + s.count + " tests" : "untested"}`;
  }).join("\n");
  const prompt = `Self-study performance across topics:\n${rows}\n\nIn 3-4 direct sentences: name the strongest and weakest areas, flag any high-priority untested topics, and give one concrete prioritization recommendation. No preamble, no hedging.`;
  const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: "user", content: prompt }] }) });
  const data = await res.json();
  return extractText(data).trim();
}

// ---------------------------------------------------------------------------
// Stats + weighted selection
// ---------------------------------------------------------------------------
function computeStats(history, topicList = TOPICS) {
  const map = {};
  for (const t of topicList) map[t.id] = { count: 0, sum: 0, avg: 0, last: null, recentQs: [] };
  for (const e of history) {
    const s = map[e.topicId]; if (!s) continue;
    s.count += 1; s.sum += e.score;
    const ts = new Date(e.date).getTime();
    if (!s.last || ts > s.last) s.last = ts;
    s.recentQs.push(e.question);
  }
  for (const id in map) { const s = map[id]; s.avg = s.count ? s.sum / s.count : 0; s.recentQs = s.recentQs.slice(-4); }
  return map;
}
function topicWeight(stat) {
  if (!stat || stat.count === 0) return 12;
  const scoreGap = 6 - stat.avg;
  const days = stat.last ? (Date.now() - stat.last) / 86400000 : 30;
  const recency = (Math.min(days, 14) / 14) * 3;
  return scoreGap * 2 + recency + 0.5;
}
function pickTopics(stats, n, topicPool = TOPICS) {
  const pool = topicPool.map((t) => ({ t, w: topicWeight(stats[t.id]) }));
  const chosen = [];
  for (let i = 0; i < n && pool.length; i++) {
    const total = pool.reduce((a, b) => a + b.w, 0);
    let r = Math.random() * total, idx = 0;
    for (let j = 0; j < pool.length; j++) { r -= pool[j].w; if (r <= 0) { idx = j; break; } }
    chosen.push(pool[idx].t); pool.splice(idx, 1);
  }
  return chosen;
}
function computeStreak(history) {
  if (!history.length) return 0;
  const days = new Set(history.map((e) => new Date(e.date).toISOString().slice(0, 10)));
  let streak = 0; const d = new Date();
  for (;;) {
    const key = d.toISOString().slice(0, 10);
    if (days.has(key)) { streak += 1; d.setDate(d.getDate() - 1); }
    else if (streak === 0 && key === new Date().toISOString().slice(0, 10)) { d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
function triggerDownload(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function buildMarkdown(history, stats, topicList) {
  const lines = ["# Learning Tracker", "", `_Exported ${new Date().toLocaleString()} · ${history.length} total entries_`, "", "## Summary by Topic", "", "| Topic | Tests | Avg | Last Tested |", "| --- | --- | --- | --- |"];
  for (const t of topicList) {
    const s = stats[t.id] || { count: 0, avg: 0, last: null };
    lines.push(`| ${t.label} | ${s.count} | ${s.count ? s.avg.toFixed(1) : "—"} | ${s.last ? new Date(s.last).toISOString().slice(0, 10) : "—"} |`);
  }
  lines.push("", "## Log", "");
  const byDay = {};
  for (const e of history) { const k = new Date(e.date).toISOString().slice(0, 10); (byDay[k] = byDay[k] || []).push(e); }
  for (const day of Object.keys(byDay).sort().reverse()) {
    lines.push(`### ${day}`, "");
    for (const e of byDay[day]) {
      const label = TOPICS.find((t) => t.id === e.topicId)?.label || e.topicId;
      lines.push(`**${label}** — Score: ${e.score}/5`, `- Q: ${e.question}`, `- A: ${e.answer || "(no answer)"}`, `- Grade: ${e.rationale}`, "");
    }
  }
  return lines.join("\n");
}
function csvCell(v) { return `"${String(v == null ? "" : v).replace(/"/g, '""')}"`; }
function buildCsv(history) {
  const rows = [["date", "topic", "score", "question", "answer", "rationale"].join(",")];
  for (const e of history) {
    const label = TOPICS.find((t) => t.id === e.topicId)?.label || e.topicId;
    rows.push([csvCell(e.date), csvCell(label), e.score, csvCell(e.question), csvCell(e.answer), csvCell(e.rationale)].join(","));
  }
  return rows.join("\n");
}

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=JetBrains+Mono:wght@400;500;600&display=swap');
.font-display { font-family: 'Fraunces', Georgia, serif; }
.font-mono2 { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.grain::before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.025;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
.fade-in { animation: fadeIn .4s ease both; }
@keyframes fadeIn { from { opacity:0; transform:translateY(8px);} to {opacity:1; transform:none;} }
textarea:focus { outline:none; }
`;

function scoreColor(score) { return ["#ef4444", "#ef4444", "#f59e0b", "#f59e0b", "#22c55e", "#22c55e"][score] || "#22c55e"; }

function loadTopicConfig() {
  let deletedIds = new Set();
  let customTopics = [];
  try { const v = localStorage.getItem(DELETED_TOPICS_KEY); if (v) deletedIds = new Set(JSON.parse(v)); } catch {}
  try { const v = localStorage.getItem(CUSTOM_TOPICS_KEY); if (v) customTopics = JSON.parse(v); } catch {}
  return { deletedIds, customTopics };
}

export default function App() {
  const [history, setHistory] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("dashboard");
  const [count, setCount] = useState(3);
  const [mode, setMode] = useState("random");
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState("");
  const [scoring, setScoring] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [validation, setValidation] = useState(null);
  const [sessionResults, setSessionResults] = useState([]);
  const [error, setError] = useState(null);
  const [aiSummary, setAiSummary] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [deletedTopicIds, setDeletedTopicIds] = useState(() => loadTopicConfig().deletedIds);
  const [customTopics, setCustomTopics] = useState(() => loadTopicConfig().customTopics);
  const [showTopicManager, setShowTopicManager] = useState(false);
  const [newTopicLabel, setNewTopicLabel] = useState("");
  const [newTopicHint, setNewTopicHint] = useState("");

  useEffect(() => { loadHistory().then((h) => { setHistory(h); setLoaded(true); }); }, []);

  useEffect(() => {
    try { localStorage.setItem(DELETED_TOPICS_KEY, JSON.stringify([...deletedTopicIds])); } catch {}
  }, [deletedTopicIds]);

  useEffect(() => {
    try { localStorage.setItem(CUSTOM_TOPICS_KEY, JSON.stringify(customTopics)); } catch {}
  }, [customTopics]);

  function deleteTopic(id) {
    if (activeList.length <= 1) return;
    if (TOPICS.find((t) => t.id === id)) {
      setDeletedTopicIds((prev) => new Set([...prev, id]));
    } else {
      setCustomTopics((prev) => prev.filter((t) => t.id !== id));
    }
    if (selectedTopic?.id === id) setSelectedTopic(null);
  }

  function addTopic() {
    const label = newTopicLabel.trim();
    if (!label) return;
    const id = "custom_" + Date.now();
    setCustomTopics((prev) => [...prev, { id, label, pillar: "Custom", hint: newTopicHint.trim() || label }]);
    setNewTopicLabel("");
    setNewTopicHint("");
  }

  const activeList = useMemo(() => [
    ...TOPICS.filter((t) => !deletedTopicIds.has(t.id)),
    ...customTopics,
  ], [deletedTopicIds, customTopics]);
  const effectiveCount = Math.min(count, activeList.length);

  const stats = useMemo(() => computeStats(history, activeList), [history, activeList]);
  const streak = useMemo(() => computeStreak(history), [history]);
  const overallAvg = useMemo(() => history.length ? history.reduce((a, e) => a + e.score, 0) / history.length : 0, [history]);
  const yesterday = useMemo(() => {
    const yKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const ys = history.filter((e) => new Date(e.date).toISOString().slice(0, 10) === yKey);
    return ys.length ? { count: ys.length, avg: ys.reduce((a, e) => a + e.score, 0) / ys.length } : null;
  }, [history]);
  const daily = useMemo(() => {
    const m = {};
    for (const e of history) { const k = new Date(e.date).toISOString().slice(0, 10); (m[k] = m[k] || []).push(e.score); }
    return Object.keys(m).sort().slice(-14).map((k) => ({ day: k, avg: m[k].reduce((a, b) => a + b, 0) / m[k].length, n: m[k].length }));
  }, [history]);
  const ranked = useMemo(() => {
    const tested = activeList.map((t) => ({ t, s: stats[t.id] })).filter((x) => x.s?.count > 0).sort((a, b) => b.s.avg - a.s.avg);
    const untested = activeList.filter((t) => !stats[t.id]?.count);
    return { strengths: tested.slice(0, 3), weaknesses: tested.slice(-3).reverse(), tested, untested };
  }, [stats, activeList]);

  async function startSession() {
    setError(null); setView("loading"); setSessionResults([]); setIdx(0); setValidation(null);
    try {
      const topics = (mode === "topic" && selectedTopic)
        ? Array(effectiveCount).fill(selectedTopic)
        : pickTopics(stats, effectiveCount, activeList);
      const asked = []; const q = [];
      for (const t of topics) {
        const recent = [...(stats[t.id]?.recentQs || []), ...asked];
        const question = await generateQuestion(t, recent);
        asked.push(question); q.push({ topic: t, question });
      }
      setQueue(q); setAnswer(""); setView("quiz");
    } catch (err) { console.error("startSession:", err); setError(String(err?.message || err)); setView("dashboard"); }
  }
  async function submitAnswer() {
    if (scoring) return; setScoring(true); setError(null);
    const current = queue[idx];
    try {
      const { score, rationale } = await scoreAnswer(current.topic, current.question, answer);
      const val = await generateValidation(current.topic, current.question, answer, score, rationale);
      const entry = { id: Date.now() + "-" + idx, date: new Date().toISOString(), topicId: current.topic.id, question: current.question, answer, score, rationale };
      const newHistory = [...history, entry];
      setHistory(newHistory); await saveHistory(newHistory);
      setLastResult({ ...entry, topicLabel: current.topic.label });
      setValidation(val);
      setSessionResults((r) => [...r, { score, topicLabel: current.topic.label }]);
      setView("result");
    } catch { setError("Scoring failed. Retry submit."); }
    finally { setScoring(false); }
  }
  function next() {
    if (idx + 1 < queue.length) { setIdx(idx + 1); setAnswer(""); setValidation(null); setView("quiz"); }
    else setView("done");
  }
  async function runSummary() {
    setSummarizing(true); setAiSummary(null);
    try { setAiSummary(await synthesizeSummary(stats, activeList)); }
    catch { setAiSummary("Summary failed — retry."); }
    finally { setSummarizing(false); }
  }

  if (!loaded) {
    return <div className="min-h-screen bg-[#000000] flex items-center justify-center"><Loader2 className="animate-spin" color="#22c55e" size={26} /></div>;
  }

  return (
    <div className="min-h-screen w-full bg-[#000000] text-[#f5f5f5] relative grain overflow-x-hidden"
      style={{ backgroundImage: "radial-gradient(1100px 560px at 82% -12%, rgba(95,168,126,.05), transparent), radial-gradient(820px 480px at -12% 112%, rgba(127,176,224,.035), transparent)" }}>
      <style>{FONT_CSS}</style>
      <div className="max-w-xl mx-auto px-5 pb-16 pt-7 relative z-10">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <a href={PORTFOLIO_URL}
            className="font-mono2 text-[11px] flex items-center gap-1 text-[#666666] hover:text-[#f5f5f5] transition-colors"
            title="Back to portfolio">
            <ChevronLeft size={13} />BACK
          </a>
          {(view === "dashboard" || view === "stats") && (
            <button onClick={() => setView(view === "stats" ? "dashboard" : "stats")}
              className="font-mono2 text-[11px] flex items-center gap-1.5 text-[#999999] hover:text-[#f5f5f5] transition-colors border border-[#333333] rounded-md px-2.5 py-1.5">
              {view === "stats" ? <><ChevronLeft size={13} /> DRILL</> : <><BarChart3 size={13} /> PROGRESS</>}
            </button>
          )}
        </div>

        {/* DASHBOARD */}
        {view === "dashboard" && (
          <div className="fade-in">
            <h1 className="font-display text-[34px] leading-[1.05] mb-1.5">Today&rsquo;s drill</h1>
            <div className="flex items-center gap-2 mb-6">
              <span className="font-mono2 text-[11px] text-[#999999]">{history.length} entries saved</span>
              {history.length > 0 && <><span className="text-[#333333]">·</span><span className="font-mono2 text-[11px] text-[#22c55e]">last: {new Date(history[history.length - 1].date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></>}
              {history.length === 0 && <span className="font-mono2 text-[11px] text-[#666666]">· no data yet</span>}
            </div>

            <div className="grid grid-cols-3 gap-2.5 mb-6">
              <Stat icon={<Flame size={14} color="#f59e0b" />} label="STREAK" value={`${streak}d`} />
              <Stat icon={<Target size={14} color="#22c55e" />} label="LIFETIME" value={history.length ? overallAvg.toFixed(1) : "—"} />
              <Stat icon={<ChevronRight size={14} color="#60a5fa" />} label="YESTERDAY" value={yesterday ? yesterday.avg.toFixed(1) : "—"} sub={yesterday ? `${yesterday.count}q` : ""} />
            </div>

            {/* Mode */}
            <div className="font-mono2 text-[11px] tracking-wider text-[#999999] mb-2.5">TOPIC SELECTION</div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <ModeBtn active={mode === "random"} onClick={() => setMode("random")} icon={<Shuffle size={14} />} label="Weighted random" />
              <ModeBtn active={mode === "topic"} onClick={() => setMode("topic")} icon={<ListChecks size={14} />} label="Choose topic" />
            </div>

            {mode === "topic" && (
              <div className="fade-in grid grid-cols-2 gap-1.5 mb-5 max-h-[230px] overflow-y-auto pr-1">
                {activeList.map((t) => {
                  const sel = selectedTopic?.id === t.id;
                  return (
                    <button key={t.id} onClick={() => setSelectedTopic(t)}
                      className="text-left px-3 py-2.5 rounded-lg border transition-all flex items-center gap-2"
                      style={{ background: sel ? "#22c55e" : "#000000", borderColor: "#22c55e", color: sel ? "#000000" : "#f5f5f5" }}>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PILLAR_COLORS[t.pillar] }} />
                      <span className="font-mono2 text-[11px] leading-tight">{t.label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="font-mono2 text-[11px] tracking-wider text-[#999999] mb-2.5">HOW MANY QUESTIONS?</div>
            <div className="grid grid-cols-5 gap-2 mb-5">
              {[1, 2, 3, 4, 5].map((n) => {
                const tooMany = n > activeList.length;
                return (
                  <button key={n} onClick={() => !tooMany && setCount(n)} disabled={tooMany}
                    className="py-3.5 rounded-xl font-display text-[22px] transition-all border disabled:opacity-30"
                    style={{ background: count === n && !tooMany ? "#22c55e" : "#1a1a1a", color: count === n && !tooMany ? "#000000" : "#f5f5f5", borderColor: count === n && !tooMany ? "#22c55e" : "#333333" }}>
                    {n}
                  </button>
                );
              })}
            </div>

            <button onClick={startSession} disabled={mode === "topic" && !selectedTopic}
              className="w-full py-4 rounded-xl font-mono2 text-[13px] tracking-[0.15em] font-semibold transition-colors disabled:opacity-40"
              style={{ background: "#22c55e", color: "#000000" }}>
              {mode === "topic" && !selectedTopic ? "SELECT A TOPIC" : "BEGIN →"}
            </button>
            {error && <p className="font-mono2 text-[12px] text-[#ef4444] text-center mt-2">{error}</p>}

            {/* Topic manager */}
            <div className="mt-6 border border-[#262626] rounded-xl overflow-hidden">
              <button
                onClick={() => setShowTopicManager((v) => !v)}
                className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-[#111111] transition-colors">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal size={13} color="#999999" />
                  <span className="font-mono2 text-[11px] tracking-wider text-[#999999]">MANAGE TOPICS</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono2 text-[10px] text-[#22c55e]">{activeList.length} active</span>
                  <ChevronRight size={13} color="#666666" className={`transition-transform ${showTopicManager ? "rotate-90" : ""}`} />
                </div>
              </button>
              {showTopicManager && (
                <div className="fade-in px-4 pb-4 pt-3 border-t border-[#262626]">

                  {/* Active topic list */}
                  <div className="space-y-1 mb-4">
                    {activeList.map((t) => (
                      <div key={t.id} className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[#222222] bg-[#0d0d0d]">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PILLAR_COLORS[t.pillar] }} />
                        <span className="font-mono2 text-[11px] text-[#e8e8e8] flex-1 truncate">{t.label}</span>
                        <button
                          onClick={() => deleteTopic(t.id)}
                          disabled={activeList.length <= 1}
                          className="shrink-0 text-[#444444] hover:text-[#ef4444] transition-colors disabled:opacity-20"
                          title="Remove topic">
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Add topic form */}
                  <div className="border border-[#222222] rounded-lg p-3 bg-[#0a0a0a]">
                    <div className="font-mono2 text-[10px] tracking-wider text-[#555555] mb-2">ADD TOPIC</div>
                    <input
                      type="text"
                      value={newTopicLabel}
                      onChange={(e) => setNewTopicLabel(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addTopic()}
                      placeholder="Topic name"
                      className="w-full bg-[#111111] border border-[#2a2a2a] rounded-lg px-3 py-2 font-mono2 text-[12px] text-[#f5f5f5] placeholder:text-[#444444] mb-2 focus:outline-none focus:border-[#444444]"
                    />
                    <input
                      type="text"
                      value={newTopicHint}
                      onChange={(e) => setNewTopicHint(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addTopic()}
                      placeholder="Scope hint (optional — what should questions focus on?)"
                      className="w-full bg-[#111111] border border-[#2a2a2a] rounded-lg px-3 py-2 font-mono2 text-[11px] text-[#f5f5f5] placeholder:text-[#444444] mb-2.5 focus:outline-none focus:border-[#444444]"
                    />
                    <button
                      onClick={addTopic}
                      disabled={!newTopicLabel.trim()}
                      className="w-full py-2 rounded-lg font-mono2 text-[11px] tracking-wider transition-colors disabled:opacity-30"
                      style={{ background: newTopicLabel.trim() ? "#22c55e" : "#1a1a1a", color: newTopicLabel.trim() ? "#000000" : "#555555" }}>
                      + ADD
                    </button>
                  </div>

                </div>
              )}
            </div>
          </div>
        )}

        {/* STATS / PROGRESS */}
        {view === "stats" && (
          <div className="fade-in">
            <h1 className="font-display text-[32px] leading-[1.05] mb-1">Progress</h1>
            <p className="font-mono2 text-[12px] text-[#999999] mb-6">{history.length} total questions · {ranked.tested.length}/{TOPICS.length} topics touched</p>

            <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl p-4 mb-4">
              <div className="font-mono2 text-[11px] tracking-wider text-[#999999] mb-3">DAILY AVG · LAST {daily.length}</div>
              {daily.length ? (
                <div className="flex items-end gap-1.5 h-24">
                  {daily.map((d) => (
                    <div key={d.day} className="flex-1 flex flex-col items-center justify-end gap-1">
                      <div className="w-full rounded-t" style={{ height: `${(d.avg / 5) * 100}%`, minHeight: 4, background: scoreColor(Math.round(d.avg)) }} title={`${d.day}: ${d.avg.toFixed(1)} (${d.n}q)`} />
                    </div>
                  ))}
                </div>
              ) : <p className="font-mono2 text-[12px] text-[#999999]">No data yet.</p>}
            </div>

            <div className="grid grid-cols-1 gap-3 mb-4">
              <SWBlock title="STRONGEST" icon={<TrendingUp size={13} color="#22c55e" />} items={ranked.strengths} />
              <SWBlock title="NEEDS WORK" icon={<TrendingDown size={13} color="#ef4444" />} items={ranked.weaknesses} />
            </div>

            {ranked.untested.length > 0 && (
              <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl p-4 mb-4">
                <div className="font-mono2 text-[11px] tracking-wider text-[#999999] mb-2">UNTESTED ({ranked.untested.length})</div>
                <div className="flex flex-wrap gap-1.5">
                  {ranked.untested.map((t) => (
                    <span key={t.id} className="font-mono2 text-[10px] px-2 py-1 rounded-full border" style={{ borderColor: PILLAR_COLORS[t.pillar] + "40", color: PILLAR_COLORS[t.pillar] }}>{t.label}</span>
                  ))}
                </div>
              </div>
            )}

            <button onClick={runSummary} disabled={summarizing || !history.length}
              className="w-full py-3 rounded-xl font-mono2 text-[12px] tracking-wider border border-[#333333] text-[#22c55e] hover:bg-[#1a1a1a] transition-colors flex items-center justify-center gap-2 mb-3 disabled:opacity-40">
              {summarizing ? <><Loader2 className="animate-spin" size={14} /> SYNTHESIZING…</> : <><Sparkles size={14} /> AI STRENGTH/WEAKNESS SUMMARY</>}
            </button>
            {aiSummary && <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl p-4 mb-4 fade-in"><p className="font-mono2 text-[12px] leading-relaxed text-[#f5f5f5]">{aiSummary}</p></div>}

            <div className="font-mono2 text-[11px] tracking-wider text-[#999999] mb-3 mt-2">FULL LEDGER</div>
            <div className="space-y-1.5 mb-6">
              {activeList.map((t) => {
                const s = stats[t.id] || { count: 0, avg: 0 }; const pct = s.count ? (s.avg / 5) * 100 : 0;
                return (
                  <div key={t.id} className="flex items-center gap-3">
                    <div className="w-1.5 h-8 rounded-full shrink-0" style={{ background: PILLAR_COLORS[t.pillar] }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono2 text-[12px] truncate text-[#e8e8e8]">{t.label}</span>
                        <span className="font-mono2 text-[11px] text-[#999999] shrink-0">{s.count ? `${s.avg.toFixed(1)} · ${s.count}×` : "untested"}</span>
                      </div>
                      <div className="h-[3px] rounded-full bg-[#262626] mt-1 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: PILLAR_COLORS[t.pillar] }} /></div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button onClick={() => triggerDownload(buildMarkdown(history, stats, activeList), `learning-tracker-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown")}
                className="py-3.5 rounded-xl font-mono2 text-[12px] tracking-wider bg-[#262626] text-[#22c55e] hover:bg-[#1c241f] transition-colors flex items-center justify-center gap-2">
                <Download size={14} /> .md
              </button>
              <button onClick={() => triggerDownload(buildCsv(history), `learning-tracker-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv")}
                className="py-3.5 rounded-xl font-mono2 text-[12px] tracking-wider bg-[#262626] text-[#60a5fa] hover:bg-[#1c241f] transition-colors flex items-center justify-center gap-2">
                <Download size={14} /> .csv
              </button>
            </div>
          </div>
        )}

        {/* LOADING */}
        {view === "loading" && (
          <div className="fade-in flex flex-col items-center justify-center py-32 gap-4">
            <Loader2 className="animate-spin" color="#22c55e" size={28} />
            <p className="font-mono2 text-[12px] text-[#999999]">Composing {effectiveCount} question{effectiveCount > 1 ? "s" : ""}…</p>
          </div>
        )}

        {/* QUIZ */}
        {view === "quiz" && queue[idx] && (
          <div className="fade-in" key={idx}>
            <div className="flex items-center justify-between mb-5">
              <span className="font-mono2 text-[11px] tracking-wider text-[#999999]">{String(idx + 1).padStart(2, "0")} / {String(queue.length).padStart(2, "0")}</span>
              <span className="font-mono2 text-[10px] tracking-wider px-2.5 py-1 rounded-full" style={{ background: "rgba(255,255,255,.03)", color: PILLAR_COLORS[queue[idx].topic.pillar], border: `1px solid ${PILLAR_COLORS[queue[idx].topic.pillar]}40` }}>{queue[idx].topic.label}</span>
            </div>
            <div className="h-[3px] rounded-full bg-[#262626] mb-7 overflow-hidden"><div className="h-full bg-[#22c55e] transition-all" style={{ width: `${(idx / queue.length) * 100}%` }} /></div>
            <p className="font-display text-[22px] leading-[1.35] mb-6">{queue[idx].question}</p>
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type your answer…" rows={7}
              className="w-full bg-[#1a1a1a] border border-[#333333] rounded-xl p-4 font-mono2 text-[14px] leading-relaxed placeholder:text-[#666666] resize-none mb-4" style={{ color: "#ffffff" }} />
            <button onClick={submitAnswer} disabled={scoring} className="w-full py-4 rounded-xl font-mono2 text-[13px] tracking-[0.15em] font-semibold transition-colors disabled:opacity-60 flex items-center justify-center gap-2" style={{ background: "#22c55e", color: "#000000" }}>
              {scoring ? <><Loader2 className="animate-spin" size={15} /> GRADING…</> : "SUBMIT ANSWER"}
            </button>
            {error && <p className="font-mono2 text-[12px] text-[#ef4444] text-center mt-2">{error}</p>}
          </div>
        )}

        {/* RESULT */}
        {view === "result" && lastResult && (
          <div className="fade-in flex flex-col items-center text-center pt-6">
            <div className="relative mb-2">
              <div className="w-28 h-28 rounded-full flex items-center justify-center font-display text-[44px]"
                style={{ background: `${scoreColor(lastResult.score)}1a`, border: `2px solid ${scoreColor(lastResult.score)}`, color: scoreColor(lastResult.score) }}>
                {lastResult.score}
              </div>
              <span className="font-mono2 text-[11px] text-[#999999] absolute -bottom-1 left-1/2 -translate-x-1/2">/ 5</span>
            </div>

            {/* Score label */}
            <div className="mb-4 mt-3">
              <span className="font-mono2 text-[12px] px-3 py-1.5 rounded-full"
                style={{ background: `${scoreColor(lastResult.score)}15`, color: scoreColor(lastResult.score), border: `1px solid ${scoreColor(lastResult.score)}40` }}>
                {SCORE_LABELS[lastResult.score]}
              </span>
            </div>

            <span className="font-mono2 text-[10px] tracking-wider px-2.5 py-1 rounded-full mb-4"
              style={{ color: PILLAR_COLORS[TOPICS.find((t) => t.id === lastResult.topicId)?.pillar], border: `1px solid ${PILLAR_COLORS[TOPICS.find((t) => t.id === lastResult.topicId)?.pillar]}40` }}>
              {lastResult.topicLabel}
            </span>

            <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl p-4 text-left w-full mb-6">
              <div className="font-mono2 text-[10px] tracking-wider mb-2" style={{ color: "#999999" }}>GRADE NOTE</div>
              <p className="font-mono2 text-[13px] leading-relaxed" style={{ color: "#ffffff" }}>{lastResult.rationale}</p>
            </div>

            {validation && (
              <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl p-4 text-left w-full mb-6 fade-in">
                <div className="font-mono2 text-[10px] tracking-wider mb-2" style={{ color: "#22c55e" }}>VALIDATION</div>
                {validation.split("\n").map((line, i) => (
                  <p key={i} className="font-mono2 text-[12px] leading-relaxed mb-1"
                    style={{ color: line.startsWith("Correct answer:") ? "#22c55e" : "#ffffff", fontWeight: line.startsWith("Correct answer:") ? 600 : 400 }}>
                    {line}
                  </p>
                ))}
              </div>
            )}

            {/* Score legend */}
            <div className="bg-[#0d0d0d] border border-[#1f1f1f] rounded-xl p-4 text-left w-full mb-6">
              <div className="font-mono2 text-[10px] tracking-wider text-[#555555] mb-2.5">SCORE GUIDE</div>
              <div className="space-y-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <div key={n} className="flex items-baseline gap-2.5">
                    <span className="font-mono2 text-[12px] font-semibold shrink-0 w-4" style={{ color: scoreColor(n) }}>{n}</span>
                    <span className="font-mono2 text-[11px]" style={{ color: lastResult.score === n ? "#e8e8e8" : "#555555" }}>{SCORE_LABELS[n]}</span>
                  </div>
                ))}
              </div>
            </div>

            <button onClick={next} className="w-full py-4 rounded-xl font-mono2 text-[13px] tracking-[0.15em] font-semibold transition-colors" style={{ background: "#22c55e", color: "#000000" }}>
              {idx + 1 < queue.length ? "NEXT QUESTION →" : "FINISH SESSION →"}
            </button>
          </div>
        )}

        {/* DONE */}
        {view === "done" && (
          <div className="fade-in pt-4">
            <h1 className="font-display text-[30px] mb-1">Session logged</h1>
            <p className="font-mono2 text-[12px] text-[#999999] mb-6">Saved to your tracker.</p>
            <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl p-5 mb-5">
              <div className="flex items-center justify-between mb-4">
                <span className="font-mono2 text-[11px] tracking-wider text-[#999999]">SESSION AVG</span>
                <span className="font-display text-[28px]" style={{ color: scoreColor(Math.round(sessionResults.reduce((a, b) => a + b.score, 0) / sessionResults.length)) }}>{(sessionResults.reduce((a, b) => a + b.score, 0) / sessionResults.length).toFixed(1)}</span>
              </div>
              <div className="space-y-2">
                {sessionResults.map((r, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="font-mono2 text-[12px] text-[#e8e8e8] truncate pr-3">{r.topicLabel}</span>
                    <span className="font-mono2 text-[13px] font-semibold shrink-0" style={{ color: scoreColor(r.score) }}>{r.score >= 4 ? <Check size={14} className="inline mb-0.5" /> : r.score <= 2 ? <X size={14} className="inline mb-0.5" /> : null} {r.score}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button onClick={() => setView("dashboard")} className="py-3.5 rounded-xl font-mono2 text-[12px] tracking-wider border border-[#333333] text-[#e8e8e8] hover:bg-[#1a1a1a] transition-colors flex items-center justify-center gap-2"><RotateCcw size={14} /> DRILL</button>
              <button onClick={() => setView("stats")} className="py-3.5 rounded-xl font-mono2 text-[12px] tracking-wider bg-[#262626] text-[#22c55e] hover:bg-[#1c241f] transition-colors flex items-center justify-center gap-2"><BarChart3 size={14} /> PROGRESS</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub }) {
  return (
    <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl px-3 py-3">
      <div className="flex items-center gap-1.5 mb-1.5">{icon}<span className="font-mono2 text-[9px] tracking-wider text-[#999999]">{label}</span></div>
      <div className="font-display text-[24px] leading-none" style={{ color: "#ffffff" }}>{value}{sub && <span className="font-mono2 text-[11px]" style={{ color: "#999999" }}>{" "}{sub}</span>}</div>
    </div>
  );
}
function ModeBtn({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} className="py-3 rounded-xl border transition-all flex items-center justify-center gap-2 font-mono2 text-[12px]"
      style={{ background: active ? "rgba(95,168,126,.10)" : "#1a1a1a", borderColor: active ? "#22c55e" : "#333333", color: active ? "#22c55e" : "#e8e8e8" }}>
      {icon} {label}
    </button>
  );
}
function SWBlock({ title, icon, items }) {
  return (
    <div className="bg-[#1a1a1a] border border-[#333333] rounded-xl p-4">
      <div className="flex items-center gap-1.5 mb-3">{icon}<span className="font-mono2 text-[11px] tracking-wider text-[#999999]">{title}</span></div>
      {items.length ? (
        <div className="space-y-2">
          {items.map(({ t, s }) => (
            <div key={t.id} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0"><span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PILLAR_COLORS[t.pillar] }} /><span className="font-mono2 text-[12px] truncate text-[#e8e8e8]">{t.label}</span></div>
              <span className="font-mono2 text-[13px] font-semibold shrink-0" style={{ color: scoreColor(Math.round(s.avg)) }}>{s.avg.toFixed(1)}</span>
            </div>
          ))}
        </div>
      ) : <p className="font-mono2 text-[12px] text-[#999999]">Not enough data.</p>}
    </div>
  );
}
