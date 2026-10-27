import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUpRight,
  Send,
  Upload,
  Check,
  FileText,
  CalendarDays,
  Network,
  ListChecks,
  MessageSquare,
  Activity,
  Building2,
  Download,
  ChevronRight,
  ShieldCheck,
  Link2,
  RefreshCw,
  LogOut,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./wetrop.css";
type Tab =
  | "Actions"
  | "Documents"
  | "Knowledge"
  | "Calendar"
  | "Reviews"
  | "Activity"
  | "Company";
const tabs = [
  ["Actions", ListChecks],
  ["Documents", FileText],
  ["Knowledge", Network],
  ["Calendar", CalendarDays],
  ["Reviews", ShieldCheck],
  ["Activity", Activity],
  ["Company", Building2],
] as const;
function tag(state: string) {
  return (
    <span
      className={`wt-tag ${/Approved|Completed|confirmed/.test(state) ? "good" : /Failed|unknown|failed|Changes/.test(state) ? "bad" : ""}`}
    >
      {state}
    </span>
  );
}
export default function App() {
  const [key, setKey] = useState(
    () => sessionStorage.getItem("wetrop-key") ?? "",
  );
  const [draftKey, setDraftKey] = useState("");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [data, setData] = useState<any>(null),
    [tab, setTab] = useState<Tab>("Actions"),
    [selected, setSelected] = useState<number | undefined>(),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [pair, setPair] = useState(""),
    [stream, setStream] = useState(""),
    [tool, setTool] = useState(""),
    [busy, setBusy] = useState(false),
    [reviewNote, setReviewNote] = useState(""),
    [now, setNow] = useState("2026-10-05T09:00"),
    [sending, setSending] = useState(false);
  const upload = useRef<HTMLInputElement>(null),
    bottom = useRef<HTMLDivElement>(null);
  async function api(path: string, body?: unknown) {
    const r = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Request failed");
    return j;
  }
  async function refresh() {
    try {
      setData(await api("state"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  async function action(path: string, body: unknown) {
    try {
      setError("");
      const result = await api(path, body);
      await refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }
  useEffect(() => {
    if (!key) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [key]);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        const r = await fetch("/api/events", {
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        if (!r.ok || !r.body) return;
        const reader = r.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!line.startsWith("data: ")) continue;
            const e = JSON.parse(line.slice(6));
            if (e.conversation !== "studio") continue;
            if (e.type === "working") {
              setBusy(true);
              setStream("");
            }
            if (e.type === "token") setStream((v) => v + e.text);
            if (e.type === "tool") setTool(e.name);
            if (e.type === "done" || e.type === "error") {
              setBusy(false);
              setStream("");
              setTool("");
              if (e.type === "error") setError(e.text);
              void refresh();
            }
          }
        }
      } catch {
        /* reconnect unless unmounted */
      }
      if (!controller.signal.aborted)
        retry = setTimeout(() => void connect(), 3000);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [key]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages?.length, stream]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    const result = await action("chat", { text, caseId: selected });
    if (result) setText("");
    setSending(false);
  }
  async function download(path: string) {
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) throw new Error("Download failed");
      const url = URL.createObjectURL(await r.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").at(-1)!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  }
  async function uploadFile(file: File) {
    try {
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "X-Filename": file.name },
        body: file,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  if (!key || !data)
    return (
      <main className="wt-login">
        <div className="wt-brand">
          w<span>etrop</span>
          <i />
        </div>
        <div className="wt-eyebrow">YOUR ADMINISTRATIVE WORKSPACE</div>
        <h1>
          Less chasing.
          <br />
          More clarity.
        </h1>
        <p>Connect to the accountant workspace for Aurora Servizi.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem("wetrop-key", draftKey.trim());
            setKey(draftKey.trim());
            setError("");
          }}
        >
          <label htmlFor="access">Workspace access key</label>
          <Input
            id="access"
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="Paste your Wetrop access key"
          />
          <Button type="submit">
            Open workspace <ArrowUpRight size={16} />
          </Button>
        </form>
        {error && (
          <p className="wt-error">
            {error}{" "}
            <button
              onClick={() => {
                sessionStorage.removeItem("wetrop-key");
                setKey("");
              }}
            >
              Try another key
            </button>
          </p>
        )}
        <small>
          Stored locally in this Wetrop project. No Steward archives are used.
        </small>
      </main>
    );
  const current = data.cases.find((c: any) => c.id === selected);
  const reviews = data.reviews.filter((r: any) => r.state === "pending");
  const conversation = data.messages.filter(
    (m: any) =>
      m.conversation === "studio" &&
      (selected === undefined || m.case_id === selected || m.case_id == null),
  );
  return (
    <div className="wt-app">
      <aside className="wt-sidebar">
        <div className="wt-brand">
          w<span>etrop</span>
          <i />
        </div>
        <div className="wt-workspace">
          <div className="wt-avatar">AS</div>
          <div>
            <strong>Aurora Servizi</strong>
            <small>Accountant workspace</small>
          </div>
        </div>
        <div className="wt-eyebrow">WORKSPACE</div>
        <nav>
          {tabs.map(([name, Icon]) => (
            <button
              key={name}
              className={tab === name ? "active" : ""}
              onClick={() => setTab(name)}
            >
              <Icon size={18} />
              {name}
              {name === "Reviews" && reviews.length > 0 && (
                <b>{reviews.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="wt-sidebar-bottom">
          <span className="wt-status-dot" /> Single-company demo
          <small>All company files stay in Wetrop.</small>
          <button
            onClick={() => {
              sessionStorage.removeItem("wetrop-key");
              setKey("");
              setData(null);
            }}
          >
            <LogOut size={14} /> Lock workspace
          </button>
        </div>
      </aside>
      <div className="wt-main">
        <header className="wt-header">
          <span>
            Workspace <ChevronRight size={14} /> {tab}
          </span>
          <div>
            <span className={`wt-tag ${data.paired ? "good" : ""}`}>
              <Link2 size={12} /> Telegram{" "}
              {data.paired
                ? "connected"
                : data.telegramConfigured
                  ? "not paired"
                  : "not configured"}
            </span>
            <button
              aria-label="Refresh workspace"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="wt-error">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {!data.modelConfigured && (
          <div className="wt-notice">
            Connect your ChatGPT plan in Company, or configure a dedicated model
            in .runtime/config.env.
          </div>
        )}
        <div className="wt-content">
          <section className="wt-panel">
            <div className="wt-heading">
              <div className="wt-eyebrow">AURORA SERVIZI S.R.L.</div>
              <h1>{tab === "Actions" ? "Everything in motion." : tab}</h1>
              <p>
                {
                  {
                    Actions:
                      "Requests, documents and deadlines. One clear view.",
                    Documents: "Originals preserved. Every result traceable.",
                    Knowledge: "Company knowledge, connected to its sources.",
                    Calendar:
                      "Internal preparation deadlines. Configurable demo dates.",
                    Reviews:
                      "Drafts reach your client immediately. You make them official.",
                    Activity: "A record of work, delivery and exceptions.",
                    Company: "One company. One connected workspace.",
                  }[tab]
                }
              </p>
            </div>
            {tab === "Actions" && (
              <>
                <div className="wt-metrics">
                  <div>
                    <strong>
                      {
                        data.cases.filter(
                          (c: any) =>
                            !["Approved", "Completed"].includes(
                              c.payload.state,
                            ),
                        ).length
                      }
                    </strong>
                    <span>Open practices</span>
                  </div>
                  <div>
                    <strong>
                      {
                        data.cases.filter(
                          (c: any) => c.payload.state === "Waiting for client",
                        ).length
                      }
                    </strong>
                    <span>Waiting for client</span>
                  </div>
                  <div>
                    <strong>{reviews.length}</strong>
                    <span>Ready for review</span>
                  </div>
                </div>
                <div className="wt-section-label">
                  YOUR PRACTICES{" "}
                  <button onClick={() => setSelected(undefined)}>
                    New conversation +
                  </button>
                </div>
                {!data.cases.length && (
                  <div className="wt-empty">
                    <ListChecks size={28} />
                    <h3>Your next task starts in chat.</h3>
                    <p>
                      Ask Wetrop to collect September invoices or fill a company
                      form.
                    </p>
                    <button
                      onClick={() =>
                        setText(
                          "Collect all September 2026 invoices, compare them with the bank movements and request any documented missing invoices.",
                        )
                      }
                    >
                      Try collecting September invoices{" "}
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                )}
                {data.cases.map((c: any) => (
                  <button
                    className={`wt-case ${selected === c.id ? "selected" : ""}`}
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                  >
                    <div className="wt-case-top">
                      <span>
                        #{c.id} · {c.payload.period ?? "Company request"}
                      </span>
                      {tag(c.payload.state)}
                    </div>
                    <h3>{c.title}</h3>
                    <p>
                      {c.payload.missing?.length
                        ? `${c.payload.missing.length} missing item(s) · ${c.payload.missing.join("; ")}`
                        : c.summary}
                    </p>
                    <div className="wt-case-bottom">
                      <span>{c.payload.results?.length ?? 0} result(s)</span>
                      <ChevronRight size={15} />
                    </div>
                  </button>
                ))}
                {current && (
                  <div className="wt-box">
                    <h3>Practice #{current.id}</h3>
                    <p>{current.payload.request}</p>
                    {current.payload.failure && (
                      <p className="wt-error">{current.payload.failure}</p>
                    )}
                    {current.payload.results?.map((p: string) => (
                      <button
                        className="wt-download"
                        key={p}
                        onClick={() => void download(p)}
                      >
                        <FileText size={16} />
                        {p.split("/").at(-1)}
                        <Download size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {tab === "Documents" && (
              <>
                <input
                  type="file"
                  hidden
                  ref={upload}
                  onChange={(e) => {
                    if (e.target.files?.[0]) void uploadFile(e.target.files[0]);
                    e.target.value = "";
                  }}
                />
                <Button onClick={() => upload.current?.click()}>
                  <Upload size={15} /> Add company document
                </Button>
                <div className="wt-list">
                  {data.documents.map((d: any) => (
                    <div className="wt-file" key={d.id}>
                      <FileText size={22} />
                      <div>
                        <strong>{d.name}</strong>
                        <small>
                          {d.source} · {d.path}
                        </small>
                      </div>
                      {tag(
                        d.approved
                          ? "Approved"
                          : d.source === "generated"
                            ? "Draft"
                            : d.status,
                      )}
                      <button
                        aria-label={`Download ${d.name}`}
                        onClick={() => void download(d.path)}
                      >
                        <Download size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {tab === "Knowledge" && (
              <>
                <div className="wt-box">
                  <h3>Connected company knowledge</h3>
                  <p>
                    {data.graph.nodes.length} nodes · {data.graph.edges.length}{" "}
                    source links
                  </p>
                  <svg
                    className="wt-graph"
                    viewBox="0 0 540 400"
                    role="img"
                    aria-label="Company knowledge graph"
                  >
                    {data.graph.edges.map((e: any, i: number) => {
                      const find = (id: string) =>
                        data.graph.nodes.findIndex((n: any) => n.id === id);
                      const pos = (i: number) =>
                        i === 0
                          ? [270, 200]
                          : [
                              270 +
                                165 *
                                  Math.cos(
                                    (i * 2 * Math.PI) /
                                      Math.max(1, data.graph.nodes.length - 1),
                                  ),
                              200 +
                                150 *
                                  Math.sin(
                                    (i * 2 * Math.PI) /
                                      Math.max(1, data.graph.nodes.length - 1),
                                  ),
                            ];
                      const a = pos(find(e.source)),
                        b = pos(find(e.target));
                      return (
                        <line
                          key={i}
                          x1={a[0]}
                          y1={a[1]}
                          x2={b[0]}
                          y2={b[1]}
                          stroke="#c8d5cf"
                        />
                      );
                    })}
                    {data.graph.nodes.map((n: any, i: number) => {
                      const x =
                          i === 0
                            ? 270
                            : 270 +
                              165 *
                                Math.cos(
                                  (i * 2 * Math.PI) /
                                    Math.max(1, data.graph.nodes.length - 1),
                                ),
                        y =
                          i === 0
                            ? 200
                            : 200 +
                              150 *
                                Math.sin(
                                  (i * 2 * Math.PI) /
                                    Math.max(1, data.graph.nodes.length - 1),
                                );
                      return (
                        <g key={n.id}>
                          <title>{n.label}</title>
                          <circle
                            cx={x}
                            cy={y}
                            r={i === 0 ? 16 : 7}
                            fill={i === 0 ? "#315b4c" : "#a7bfb0"}
                          />
                          <text
                            x={x + 11}
                            y={y + 4}
                            fontSize="9"
                            fill="#4b6156"
                          >
                            {n.label.slice(0, 21)}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
                {data.graph.nodes
                  .filter((n: any) => n.path?.endsWith(".md"))
                  .map((n: any) => (
                    <button
                      className="wt-download"
                      key={n.id}
                      onClick={() => void download(n.path)}
                    >
                      <Network size={16} />
                      {n.label}
                      <Download size={14} />
                    </button>
                  ))}
              </>
            )}
            {tab === "Calendar" && (
              <>
                <div className="wt-box">
                  <h3>Demo clock</h3>
                  <p>
                    Current: {new Date(data.demoNow).toLocaleString("en-GB")} ·
                    Europe/Rome
                  </p>
                  <label htmlFor="clock">Advance to a preparation date</label>
                  <Input
                    id="clock"
                    type="datetime-local"
                    value={now}
                    onChange={(e) => setNow(e.target.value)}
                  />
                  <Button
                    onClick={() =>
                      void action("clock", { now: new Date(now).toISOString() })
                    }
                  >
                    Run deadline check
                  </Button>
                  <small>
                    Starts real practices and may send messages to the paired
                    demo client.
                  </small>
                </div>
                {data.calendar.map((c: any) => (
                  <div className="wt-box" key={c.id}>
                    <div className="wt-case-top">
                      <CalendarDays size={18} />
                      {tag(c.enabled ? "Enabled" : "Disabled")}
                    </div>
                    <h3>{c.title}</h3>
                    <p>
                      {new Date(c.due).toLocaleString("en-GB")} · Period{" "}
                      {c.period}
                    </p>
                    <p>{c.task}</p>
                    <button
                      onClick={() => {
                        const due = window.prompt(
                          "Internal preparation deadline (ISO date with timezone)",
                          c.due,
                        );
                        if (due) void action("deadline", { id: c.id, due });
                      }}
                    >
                      Edit date
                    </button>{" "}
                    <button
                      onClick={() =>
                        void action("deadline", {
                          id: c.id,
                          enabled: !c.enabled,
                        })
                      }
                    >
                      {c.enabled ? "Disable" : "Enable"}
                    </button>
                  </div>
                ))}
              </>
            )}
            {tab === "Reviews" && (
              <>
                <label htmlFor="review-note">
                  Feedback for changes or rejection
                </label>
                <textarea
                  id="review-note"
                  placeholder="Explain the correction Wetrop should make…"
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                />
                {!reviews.length && (
                  <div className="wt-empty">
                    <ShieldCheck size={28} />
                    <h3>No drafts waiting.</h3>
                    <p>
                      New documents sent to the client will appear here for your
                      review.
                    </p>
                  </div>
                )}
                {reviews.map((r: any) => (
                  <div className="wt-box" key={r.id}>
                    {tag("Awaiting review")}
                    <h3>{r.name}</h3>
                    <p>
                      Practice #{r.case_id} · Client receives a draft before
                      approval.
                    </p>
                    <button
                      className="wt-download"
                      onClick={() => void download(r.path)}
                    >
                      <Download size={15} /> Inspect draft
                    </button>
                    <div className="wt-buttons">
                      <Button
                        onClick={() =>
                          void action("review", {
                            id: r.id,
                            decision: "approve",
                            note: reviewNote,
                          })
                        }
                      >
                        <Check size={15} /> Approve
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!reviewNote.trim()}
                        onClick={() =>
                          void action("review", {
                            id: r.id,
                            decision: "changes",
                            note: reviewNote,
                          })
                        }
                      >
                        Request changes
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() =>
                          void action("review", {
                            id: r.id,
                            decision: "reject",
                            note: reviewNote,
                          })
                        }
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
                {data.approvals
                  .filter((a: any) => a.state === "pending")
                  .map((a: any) => (
                    <div className="wt-box" key={a.id}>
                      <h3>File operation approval</h3>
                      <pre>{a.input}</pre>
                      <Button
                        onClick={() =>
                          void action("file-approval", {
                            id: a.id,
                            allow: true,
                          })
                        }
                      >
                        Allow
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() =>
                          void action("file-approval", {
                            id: a.id,
                            allow: false,
                          })
                        }
                      >
                        Deny
                      </Button>
                    </div>
                  ))}
              </>
            )}
            {tab === "Activity" && (
              <>
                <div className="wt-box">
                  <h3>Usage</h3>
                  <p>
                    Tool and model usage is recorded locally. Provider charges
                    require a configured price schedule.
                  </p>
                  <pre>{JSON.stringify(data.usage?.totals ?? {}, null, 2)}</pre>
                </div>
                <h3>Jobs</h3>
                {data.jobs.map((j: any) => (
                  <div className="wt-box" key={j.id}>
                    {tag(j.state)}
                    <p>{j.text.slice(0, 140)}</p>
                    {j.error && <p className="wt-error">{j.error}</p>}
                    {j.state === "failed" && (
                      <button
                        onClick={() => void action("retry-job", { id: j.id })}
                      >
                        Retry task
                      </button>
                    )}
                  </div>
                ))}
                <h3>Deliveries</h3>
                {data.deliveries.map((d: any) => (
                  <div className="wt-file" key={d.id}>
                    <span>{d.kind}</span>
                    {tag(d.state)}
                    {d.error && <small>{d.error}</small>}
                  </div>
                ))}
                <h3>Audit</h3>
                {(data.activity?.events ?? []).map((e: any) => (
                  <div className="wt-audit" key={e.id}>
                    <small>{new Date(e.ts).toLocaleString("en-GB")}</small>
                    <p>{e.summary}</p>
                  </div>
                ))}
              </>
            )}
            {tab === "Company" && (
              <>
                <div className="wt-box">
                  <div className="wt-avatar">AS</div>
                  <h3>{data.company.name}</h3>
                  <p>{data.company.address}</p>
                  <p>VAT identifier: {data.company.vatNumber}</p>
                  <p>{data.company.taxRegime}</p>
                  <small>
                    Synthetic demo data. Identifiers are deliberately invalid.
                  </small>
                </div>
                <div className="wt-box">
                  <h3>AI provider · ChatGPT plan</h3>
                  <p>
                    {data.chatgpt?.connected
                      ? `Connected as ${data.chatgpt.name ?? data.chatgpt.email ?? "your ChatGPT account"}`
                      : "Use your ChatGPT subscription through an explicit Wetrop connection."}
                  </p>
                  <p>Selected model: {data.chatgpt?.model ?? "not selected"}</p>
                  <Button
                    onClick={async () => {
                      const result = await action("chatgpt/login", {});
                      if (result)
                        window.open(
                          result.url,
                          "_blank",
                          "noopener,noreferrer",
                        );
                    }}
                  >
                    Continue with ChatGPT
                  </Button>
                  <small>
                    Complete the browser sign-in on the Mac running Wetrop.
                    Tokens stay in .runtime and are never shared with company
                    tools.
                  </small>
                  {data.chatgpt?.login?.error && (
                    <p role="alert">{data.chatgpt.login.error}</p>
                  )}
                  {data.chatgpt?.connected && (
                    <>
                      <Button
                        variant="outline"
                        onClick={async () => {
                          const result = await action("chatgpt/models", {});
                          if (result) setModels(result.models);
                        }}
                      >
                        Load available models
                      </Button>
                      {models.length > 0 && (
                        <select
                          aria-label="ChatGPT model"
                          value={data.chatgpt.model ?? ""}
                          onChange={(e) =>
                            void action("chatgpt/model", {
                              model: e.target.value,
                            })
                          }
                        >
                          <option value="" disabled>
                            Select a model
                          </option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <Button
                        variant="outline"
                        onClick={async () => {
                          const result = await action("chatgpt/logout", {});
                          if (result && !result.revoked)
                            setError(result.message);
                        }}
                      >
                        Disconnect ChatGPT
                      </Button>
                    </>
                  )}
                  {(data.chatgpt?.accounts ?? [])
                    .filter((a: any) => a.id !== data.chatgpt.accountId)
                    .map((a: any) => (
                      <button
                        key={a.id}
                        onClick={() =>
                          void action("chatgpt/account", { accountId: a.id })
                        }
                      >
                        Switch to {a.name ?? a.email ?? a.id}
                      </button>
                    ))}
                </div>
                <div className="wt-box">
                  <h3>Connect the client on Telegram</h3>
                  <p>
                    Generate a one-time code, valid for 10 minutes. In your
                    dedicated bot, send:
                  </p>
                  <Button
                    disabled={!data.telegramConfigured}
                    onClick={async () => {
                      const result = await action("pair", {});
                      if (result) setPair(result.code);
                    }}
                  >
                    Generate pairing code
                  </Button>
                  {pair && <pre>/start {pair}</pre>}
                  <p>
                    {data.paired
                      ? "An authorized client is paired."
                      : "No client is paired yet."}
                  </p>
                </div>
              </>
            )}
          </section>
          <section className="wt-chat">
            <div className="wt-chat-header">
              <div className="wt-agent-mark">
                <MessageSquare size={18} />
              </div>
              <div>
                <strong>Wetrop assistant</strong>
                <small>
                  {selected ? `Practice #${selected}` : "Company workspace"}
                </small>
              </div>
              <span className="wt-status-dot" />
            </div>
            <div className="wt-messages">
              {!conversation.length && !stream && (
                <div className="wt-chat-welcome">
                  <span className="wt-eyebrow">YOUR NEXT TASK, HANDLED</span>
                  <h2>
                    What should we
                    <br />
                    take care of?
                  </h2>
                  <p>
                    Find documents, prepare drafts or ask your client for what
                    is missing.
                  </p>
                  {[
                    "What do we know about Aurora Servizi?",
                    "Prepare a September expense summary.",
                    "Fill templates/company-form.docx with company data.",
                  ].map((q) => (
                    <button key={q} onClick={() => setText(q)}>
                      {q}
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              )}
              {conversation.map((m: any) => (
                <article
                  key={m.id}
                  className={`wt-message ${m.role === "accountant" ? "user" : ""}`}
                >
                  <small>{m.role === "accountant" ? "You" : "Wetrop"}</small>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      img: () => null,
                      a: ({ children }) => <span>{children}</span>,
                    }}
                  >
                    {m.text}
                  </ReactMarkdown>
                </article>
              ))}
              {stream && (
                <article className="wt-message">
                  <small>Wetrop</small>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      img: () => null,
                      a: ({ children }) => <span>{children}</span>,
                    }}
                  >
                    {stream}
                  </ReactMarkdown>
                </article>
              )}
              {busy && (
                <div className="wt-thinking">
                  <span className="wt-status-dot" />
                  {tool
                    ? tool.replace("mcp__", "").replaceAll("__", " · ")
                    : "Working on your request…"}
                </div>
              )}
              <div ref={bottom} />
            </div>
            <form className="wt-composer" onSubmit={send}>
              <textarea
                aria-label="Message Wetrop"
                placeholder={
                  selected
                    ? `Continue practice #${selected}…`
                    : "Ask Wetrop to find, prepare or follow up…"
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(e);
                  }
                }}
              />
              <div>
                <small>Source-backed work. You approve the result.</small>
                <Button
                  type="submit"
                  aria-label="Send message"
                  disabled={!text.trim() || sending}
                >
                  <Send size={16} />
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
