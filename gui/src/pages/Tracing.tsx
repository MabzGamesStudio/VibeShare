// Settings → Tracing: the trace log the client daemon keeps (off by default) — search,
// time span, level filters, and one timeline per user action or API call holding
// everything it caused. The view itself is the shared one the node consoles use.
import { api, IS_STATIC } from '../api';
import { traceApiOf, TracingView } from '../components/Tracing';

// Built once: TracingView refetches the settings whenever its api handle changes.
const TRACE_API = traceApiOf(api, '/api/tracing');

export function TracingSection() {
  return (
    <div className="form-stack" id="tracing">
      <div className="card form-stack">
        <h2>Tracing</h2>
        <p className="small muted">
          What this client has been doing: each action you take and everything it causes, kept on this device while trace logs are on (Settings
          → Logging). Nothing at all is recorded until then.
        </p>
      </div>
      {IS_STATIC ? (
        <div className="card form-stack">
          <p className="hint">
            Trace logs are kept by the client daemon — open the desktop app (or run <code>vibeshare client</code>) to record and view them.
          </p>
        </div>
      ) : (
        <TracingView api={TRACE_API} />
      )}
    </div>
  );
}