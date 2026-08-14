import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldCheck, SlidersHorizontal, Wrench, XCircle } from 'lucide-react';
import { PRODUCT_VARIANT } from '../../shared/product_variant';
import { industrySettingsCopy } from '../i18n/locales/industrySettings';
import { apiFetch } from '../services/apiClient';
import { Settings } from './Settings';

type McpHealth = { name: string; status: string; connected: boolean };

const CONNECTION_MATCHERS: Record<string, RegExp> = {
  ecommerce: /ecommerce|commerce|market|shop|playwright|customer|wechat|wecom/i,
  design: /cad|autocad|design|render|image|presentation|revit|ifc/i,
  legal: /legal|law|court|statute|case|document|browser|search/i,
  finance: /finance|tax|invoice|account|excel|spreadsheet|office|bank/i,
};

export function IndustrySettings({
  t,
  lang,
  setLang,
  activeSection = 'general',
  onSectionChange,
}: {
  t: any;
  lang: 'en' | 'zh';
  setLang: (language: 'en' | 'zh') => void;
  activeSection?: string;
  onSectionChange?: (section: string) => void;
}) {
  const copy = industrySettingsCopy(PRODUCT_VARIANT.productLine, lang);
  const [mode, setMode] = useState<'industry' | 'core'>(activeSection === 'general' ? 'industry' : 'core');
  const [health, setHealth] = useState<McpHealth[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeSection !== 'general') setMode('core');
  }, [activeSection]);

  const refreshHealth = async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/mcp/health');
      const payload = await response.json().catch(() => ({}));
      const servers = payload?.servers && typeof payload.servers === 'object' ? payload.servers : {};
      setHealth(Object.entries(servers).map(([name, value]: [string, any]) => {
        const status = String(value?.status || 'unknown');
        return { name, status, connected: ['connected', 'idle'].includes(status) };
      }));
    } catch {
      setHealth([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refreshHealth(); }, []);

  const industryConnections = useMemo(() => {
    const matcher = CONNECTION_MATCHERS[PRODUCT_VARIANT.productLine] || /.^/;
    return health.filter(item => matcher.test(item.name));
  }, [health]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.08),transparent_34%)] text-white">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-black/20 px-5 py-3 backdrop-blur-xl">
        <div className="min-w-0">
          <div className="truncate text-sm font-black">{PRODUCT_VARIANT.runtime.productName}</div>
          <div className="text-xs text-white/35">{copy.corePreserved}</div>
        </div>
        <div className="flex shrink-0 rounded-xl border border-white/10 bg-black/20 p-1">
          <button type="button" onClick={() => setMode('industry')} className={`rounded-lg px-3 py-2 text-xs font-black transition ${mode === 'industry' ? 'bg-cyan-300 text-[#061014]' : 'text-white/45 hover:text-white'}`}>
            {copy.industryTab}
          </button>
          <button type="button" onClick={() => setMode('core')} className={`rounded-lg px-3 py-2 text-xs font-black transition ${mode === 'core' ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white'}`}>
            {copy.coreTab}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {mode === 'core' ? (
          <Settings t={t} lang={lang} setLang={setLang} activeSection={activeSection} onSectionChange={onSectionChange} />
        ) : (
          <div className="h-full overflow-y-auto p-5 sm:p-7">
            <div className="mx-auto max-w-6xl space-y-5">
              <header>
                <h2 className="text-2xl font-black tracking-tight">{copy.title}</h2>
                <p className="mt-1 text-sm text-white/45">{copy.description}</p>
              </header>

              <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-3xl border border-white/10 bg-black/25 p-5 backdrop-blur-xl">
                  <h3 className="flex items-center gap-2 text-sm font-black"><Wrench size={17} className="text-cyan-200" />{copy.skillsTitle}</h3>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {PRODUCT_VARIANT.runtime.defaultSkills.map(skill => <span key={skill} className="rounded-xl border border-cyan-300/15 bg-cyan-300/[0.07] px-3 py-2 text-xs font-bold text-cyan-100/75">{skill}</span>)}
                  </div>
                </div>
                <div className="rounded-3xl border border-white/10 bg-black/25 p-5 backdrop-blur-xl">
                  <h3 className="flex items-center gap-2 text-sm font-black"><SlidersHorizontal size={17} className="text-emerald-200" />{copy.modulesTitle}</h3>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {PRODUCT_VARIANT.runtime.modules.map(moduleId => <span key={moduleId} className="rounded-xl border border-emerald-300/15 bg-emerald-300/[0.07] px-3 py-2 text-xs font-bold text-emerald-100/75">{moduleId}</span>)}
                  </div>
                </div>
              </section>

              <section className="rounded-3xl border border-white/10 bg-black/25 p-5 backdrop-blur-xl">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-black">{copy.connectionTitle}</h3>
                    <p className="mt-1 text-xs leading-5 text-white/35">{copy.connectionDescription}</p>
                  </div>
                  <button type="button" onClick={() => void refreshHealth()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-white/55 hover:bg-white/10 disabled:opacity-50">
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {loading ? copy.loading : copy.refresh}
                  </button>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {industryConnections.length === 0 ? (
                    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4 text-sm text-white/40">{copy.notConfigured}</div>
                  ) : industryConnections.map(connection => (
                    <div key={connection.name} className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm font-black text-white/75">{connection.name}</span>
                        {connection.connected ? <CheckCircle2 size={17} className="shrink-0 text-emerald-300" /> : <XCircle size={17} className="shrink-0 text-amber-200" />}
                      </div>
                      <div className="mt-2 text-xs text-white/35">{connection.connected ? copy.connected : `${copy.disconnected} · ${connection.status}`}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-3xl border border-amber-300/15 bg-amber-300/[0.055] p-5">
                <h3 className="flex items-center gap-2 text-sm font-black text-amber-100"><ShieldCheck size={18} />{copy.approvalTitle}</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {copy.boundaries.map(item => <div key={item} className="flex items-start gap-2 rounded-xl border border-amber-200/10 bg-black/10 p-3 text-xs leading-5 text-amber-50/65"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-amber-200" />{item}</div>)}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
