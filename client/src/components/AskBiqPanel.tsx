import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Drawer, Dropdown, Input, Spin, Tag, Tooltip } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, HistoryOutlined, PlusOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  askBiq, deleteAskBiqConversation, getAskBiqConversation, getAskBiqConversations, getAskBiqStatus,
  type AskBiqRef, type AskBiqTurn,
} from '../api';
import { SmcMark } from './brand/SmcLogo';

/**
 * "Ask BIQ": a chat panel that answers questions from live BIQ data
 * (server/services/assistant). Answers stream in; the lookups the assistant
 * made are listed under each answer; cited flows, applications, controls and
 * Jira issues become links.
 */

export interface AskBiqContext { tab?: string; diagramId?: string; diagramName?: string; application?: string }

interface Props {
  open: boolean;
  onClose: () => void;
  context?: AskBiqContext;
  onOpenFlow: (diagramId: string) => void;
  onOpenApplication: (acronym: string) => void;
}

type ToolStep = { id: string; label: string; status: 'running' | 'done' | 'error'; error?: string };
type Turn = AskBiqTurn & { steps?: ToolStep[]; streaming?: boolean; failed?: string };

const SUGGESTIONS = [
  'Which flows have the lowest SOX compliance, and what are their open High deviations?',
  'What are the 5 most expensive business flows by TCO, and how did they change from last year?',
  'Which flows depend on CONNECTED-CAR?',
  'Which flows have the most late Jira work, and how many story points are in flight by domain?',
  'What Jira work on Digital Retailing Journey is overdue?',
  'Which flows will be most exposed to unsupported hardware and software over the next 3 years?',
  'How did vehicles sold and warranty claims paid compare with the previous 7 days?',
  'Tell me about the WARRANTY-SALES application: owners, cost and risk.',
];

// Inside Markdown tables the model escapes the separator as "\|".
const MARKER = /\[\[(flow|app|control|jira):([^|\]\\]+)\\?(?:\|([^\]]+))?\]\]/g;

/** [[flow:id|Name]] → [Name](biq:flow/id); Jira keys link straight to Jira when the URL is known. */
function toMarkdown(text: string, refs: Map<string, AskBiqRef>): string {
  return text.replace(MARKER, (_m, kind: string, rawId: string, rawName?: string) => {
    const id = rawId.trim();
    const ref = refs.get(`${kind}:${id}`);
    const label = (rawName || (kind === 'jira' || kind === 'control' ? id : ref?.name) || id).replace(/[[\]]/g, '');
    if (kind === 'jira' && ref?.url) return `[${label}](${ref.url})`;
    return `[${label}](biq:${kind}/${encodeURIComponent(id)})`;
  });
}

export default function AskBiqPanel({ open, onClose, context, onOpenFlow, onOpenApplication }: Props) {
  const [status, setStatus] = useState<{ configured: boolean; model: string } | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadHistory = useCallback(() => { getAskBiqConversations().then(setHistory).catch(() => setHistory([])); }, []);
  useEffect(() => {
    if (!open) return;
    getAskBiqStatus().then(setStatus).catch(() => setStatus(null));
    loadHistory();
  }, [open, loadHistory]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const newChat = () => {
    abortRef.current?.abort();
    setConversationId(null);
    setTurns([]);
    setDraft('');
  };

  const openConversation = async (id: string) => {
    abortRef.current?.abort();
    const convo = await getAskBiqConversation(id);
    setConversationId(convo.id);
    setTurns(convo.turns);
  };

  const removeConversation = async () => {
    if (!conversationId) return;
    await deleteAskBiqConversation(conversationId).catch(() => {});
    newChat();
    loadHistory();
  };

  const send = async (text?: string) => {
    const question = (text ?? draft).trim();
    if (!question || busy) return;
    setDraft('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setTurns((current) => [...current, { role: 'user', text: question }, { role: 'assistant', text: '', steps: [], streaming: true }]);
    const patchLast = (fn: (t: Turn) => Turn) => setTurns((current) => {
      const next = [...current];
      next[next.length - 1] = fn(next[next.length - 1]);
      return next;
    });
    try {
      await askBiq({ conversationId, message: question, context: context as Record<string, string | undefined> | undefined }, (event) => {
        if (event.type === 'meta') setConversationId(event.conversationId);
        else if (event.type === 'text') patchLast((t) => ({ ...t, text: t.text + event.delta }));
        else if (event.type === 'tool') {
          patchLast((t) => {
            const steps = [...(t.steps || [])];
            const i = steps.findIndex((s) => s.id === event.id);
            const step = { id: event.id, label: event.label, status: event.status, error: event.error };
            if (i >= 0) steps[i] = step; else steps.push(step);
            return { ...t, steps };
          });
        } else if (event.type === 'done') patchLast((t) => ({ ...t, refs: event.refs, tools: event.tools, streaming: false }));
        else if (event.type === 'error') patchLast((t) => ({ ...t, streaming: false, failed: event.message }));
      }, controller.signal);
    } catch (err: any) {
      if (err?.name !== 'AbortError') patchLast((t) => ({ ...t, streaming: false, failed: err?.message || 'Ask BIQ failed' }));
      else patchLast((t) => ({ ...t, streaming: false, failed: 'Stopped.' }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      loadHistory();
    }
  };

  const contextLine = useMemo(() => {
    if (context?.diagramName) return `Looking at: ${context.diagramName}`;
    if (context?.application) return `Looking at: ${context.application}`;
    return context?.tab ? `On: ${context.tab}` : '';
  }, [context]);

  const suggestions = useMemo(() => {
    const list = [...SUGGESTIONS];
    if (context?.diagramName) list.unshift(`What does ${context.diagramName} cost, what SOX findings and Jira work affect it, and which applications does it depend on?`);
    if (context?.application) list.unshift(`Tell me about ${context.application}: owners, cost, risk and the flows that use it.`);
    return list.slice(0, 6);
  }, [context]);

  const renderAnswer = (turn: Turn) => {
    const refs = new Map((turn.refs || []).map((r) => [`${r.kind}:${r.id}`, r]));
    return (
      <div className="askbiq-md text-sm leading-6 text-slate-800">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => (url.startsWith('biq:') ? url : defaultUrlTransform(url))}
          components={{
            a: ({ href, children }) => {
              if (href?.startsWith('biq:')) {
                const [kind, ...rest] = href.slice(4).split('/');
                const id = decodeURIComponent(rest.join('/'));
                if (kind === 'flow') return <button type="button" className="askbiq-link" onClick={() => onOpenFlow(id)} title="Open this flow">{children}</button>;
                if (kind === 'app') return <button type="button" className="askbiq-link" onClick={() => onOpenApplication(id)} title="Open this application">{children}</button>;
                return <Tooltip title={refs.get(`${kind}:${id}`)?.name || id}><span className="askbiq-chip">{children}</span></Tooltip>;
              }
              return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
            },
          }}
        >
          {toMarkdown(turn.text, refs)}
        </ReactMarkdown>
      </div>
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={500}
      mask={false}
      placement="right"
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
      title={(
        <span className="flex items-center gap-2">
          <SmcMark size={22} />
          <span>Ask BIQ</span>
          {status?.model ? <Tag className="!ml-1" color="blue">{status.model}</Tag> : null}
        </span>
      )}
      extra={(
        <span className="flex items-center gap-1">
          <Dropdown
            trigger={['click']}
            disabled={!history.length}
            menu={{ items: history.map((h) => ({ key: h.id, label: <span className="block max-w-[320px] truncate">{h.title || 'Untitled'}</span> })), onClick: ({ key }) => { void openConversation(String(key)); } }}
          >
            <Button size="small" icon={<HistoryOutlined />} title="Earlier conversations" aria-label="Earlier conversations" />
          </Dropdown>
          {conversationId ? <Button size="small" icon={<DeleteOutlined />} title="Delete this conversation" aria-label="Delete this conversation" onClick={() => { void removeConversation(); }} /> : null}
          <Button size="small" icon={<PlusOutlined />} onClick={newChat}>New</Button>
        </span>
      )}
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {status && !status.configured ? (
          <Alert type="warning" showIcon className="mb-3" message="Ask BIQ isn't set up on this server yet" description="An Anthropic API key is needed (ANTHROPIC_API_KEY in server/.env, or Key Vault on Azure)." />
        ) : null}
        {!turns.length ? (
          <div>
            <p className="mt-1 text-sm text-slate-600">
              Ask about SMC's business flows, applications, costs, SOX controls, Jira work and business measures. Answers come from live BIQ data, with links to what they cite.
            </p>
            {contextLine ? <div className="mb-2 text-xs text-slate-400">{contextLine}</div> : null}
            <div className="flex flex-col gap-2">
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => { void send(s); }} disabled={busy || status?.configured === false}
                  className="cursor-pointer rounded-lg border border-solid border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 transition hover:border-sky-300 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-60">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {turns.map((turn, i) => (turn.role === 'user' ? (
          <div key={i} className="mb-3 mt-2 flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-600 px-3 py-2 text-sm text-white">{turn.text}</div>
          </div>
        ) : (
          <div key={i} className="mb-4">
            {(turn.steps?.length || turn.tools?.length) ? (
              <details className="mb-1 text-xs text-slate-500" open={turn.streaming}>
                <summary className="cursor-pointer select-none">
                  {turn.streaming && turn.steps?.some((s) => s.status === 'running') ? <Spin size="small" className="mr-1" /> : null}
                  Looked up {(turn.steps?.length || turn.tools?.length || 0)} thing{(turn.steps?.length || turn.tools?.length) === 1 ? '' : 's'}
                </summary>
                <ul className="m-0 mt-1 list-none pl-2">
                  {(turn.steps || (turn.tools || []).map((t, k) => ({ id: String(k), label: t.label, status: t.ok === false ? 'error' : 'done', error: t.error }) as ToolStep)).map((s) => (
                    <li key={s.id} className="flex items-center gap-1.5 py-0.5">
                      {s.status === 'running' ? <Spin size="small" /> : s.status === 'error' ? <CloseCircleFilled style={{ color: '#dc2626' }} /> : <CheckCircleFilled style={{ color: '#16a34a' }} />}
                      <span>{s.label}{s.error ? `: ${s.error}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {turn.text ? renderAnswer(turn) : turn.streaming ? <div className="flex items-center gap-2 text-sm text-slate-500"><Spin size="small" /> Thinking…</div> : null}
            {turn.failed ? <Alert type="error" showIcon className="mt-2" message={turn.failed} /> : null}
          </div>
        )))}
      </div>
      <div className="border-0 border-t border-solid border-slate-200 bg-slate-50 p-3">
        <div className="flex items-end gap-2">
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send(); } }}
            autoSize={{ minRows: 1, maxRows: 6 }}
            placeholder="Ask about flows, apps, costs, SOX, Jira…"
            disabled={status?.configured === false}
            aria-label="Question for Ask BIQ"
          />
          {busy ? (
            <Button icon={<StopOutlined />} onClick={() => abortRef.current?.abort()} title="Stop" aria-label="Stop" />
          ) : (
            <Button type="primary" icon={<SendOutlined />} onClick={() => { void send(); }} disabled={!draft.trim() || status?.configured === false} title="Send" aria-label="Send" />
          )}
        </div>
        <div className="mt-1 text-[11px] text-slate-400">Answers come from BIQ data you have access to. Enter to send, Shift+Enter for a new line.</div>
      </div>
    </Drawer>
  );
}
