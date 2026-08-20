const supabase = require('../config/supabase');
const { ensureMonthlyChargesForAcademy, todayInChile } = require('./monthlyBilling');
const { sendStatementsForAcademy } = require('./collectionService');

const chileHour = () => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Santiago', hour: '2-digit', hourCycle: 'h23',
}).format(new Date()));

const dueDateForCurrentMonth = (today, requestedDay) => {
  const [year, month] = String(today).slice(0, 7).split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(Number(requestedDay) || 1, 1), lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const diffDays = (from, to) => {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86400000);
};

const runCollectionAutomation = async () => {
  const today = todayInChile();
  const hour = chileHour();
  const period = String(today).slice(0, 7);
  const { data: configs, error } = await supabase.from('configuracion_financiera')
    .select('academia_id,cobranza_automatica,cobranza_auto_email,cobranza_auto_whatsapp,cobranza_recordar_antes,cobranza_recordar_vencido,cobranza_dias_mora,cobranza_hora_local,academias!inner(id,nombre,estado,dia_vencimiento_mensualidad,dias_aviso_mensualidad)')
    .eq('cobranza_automatica', true);
  if (error) throw error;

  const summary = { checked: 0, triggered: 0, emails: 0, whatsapps: 0, errors: 0, details: [] };
  for (const cfg of configs || []) {
    summary.checked += 1;
    const academy = cfg.academias;
    if (!academy || String(academy.estado || '').toLowerCase() === 'inactiva') continue;
    const configuredHour = Math.max(0, Math.min(23, Number(cfg.cobranza_hora_local ?? 9)));
    if (hour < configuredHour) continue;
    const dueDay = Number(academy.dia_vencimiento_mensualidad || 0);
    if (!dueDay) continue;

    try {
      await ensureMonthlyChargesForAcademy(cfg.academia_id);
      const dueDate = dueDateForCurrentMonth(today, dueDay);
      const untilDue = diffDays(today, dueDate);
      const warningDays = Math.max(0, Math.min(15, Number(academy.dias_aviso_mensualidad ?? 3)));
      const channels = [];
      if (cfg.cobranza_auto_email !== false) channels.push('email');
      if (cfg.cobranza_auto_whatsapp !== false) channels.push('whatsapp');
      if (!channels.length) continue;

      let trigger = null;
      if (cfg.cobranza_recordar_antes !== false && untilDue === warningDays) {
        trigger = {
          onlyOverdue: false,
          type: 'proximo_vencimiento',
          prefix: `auto:${period}:pre:${warningDays}`,
        };
      } else if (cfg.cobranza_recordar_vencido !== false && untilDue < 0) {
        const lateDays = Math.abs(untilDue);
        const configuredLateDays = Array.isArray(cfg.cobranza_dias_mora) ? cfg.cobranza_dias_mora.map(Number) : [1, 5, 10, 15];
        if (configuredLateDays.includes(lateDays)) {
          trigger = {
            onlyOverdue: true,
            type: `mora_d${lateDays}`,
            prefix: `auto:${period}:late:${lateDays}`,
          };
        }
      }
      if (!trigger) continue;

      summary.triggered += 1;
      const result = await sendStatementsForAcademy({
        academyId: cfg.academia_id,
        onlyOverdue: trigger.onlyOverdue,
        channels,
        userId: null,
        via: 'automatizacion',
        notificationType: trigger.type,
        dedupePrefix: trigger.prefix,
      });
      summary.emails += result.emails;
      summary.whatsapps += result.whatsapps;
      summary.errors += result.errores;
      summary.details.push({ academia_id: cfg.academia_id, evento: trigger.type, ...result });
    } catch (automationError) {
      summary.errors += 1;
      summary.details.push({ academia_id: cfg.academia_id, error: String(automationError?.message || automationError).slice(0, 400) });
      console.error(`Cobranza automática falló para academia ${cfg.academia_id}:`, automationError?.message || automationError);
    }
  }
  if (summary.triggered || summary.errors) console.log('Cobranza automática:', JSON.stringify(summary));
  return summary;
};

const startCollectionAutomation = () => {
  const intervalMs = Math.max(30 * 60 * 1000, Number(process.env.COLLECTION_AUTOMATION_INTERVAL_MS || 60 * 60 * 1000));
  let timer = null;
  let warmup = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runCollectionAutomation(); }
    catch (error) { console.error('Error general en cobranza automática:', error?.message || error); }
    finally { running = false; }
  };
  warmup = setTimeout(() => void tick(), 45_000);
  warmup.unref?.();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    stop() {
      if (warmup) clearTimeout(warmup);
      if (timer) clearInterval(timer);
      warmup = null;
      timer = null;
    },
    runNow: tick,
  };
};

module.exports = { runCollectionAutomation, startCollectionAutomation };
