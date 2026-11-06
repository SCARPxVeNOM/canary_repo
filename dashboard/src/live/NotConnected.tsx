/** Shown when no Canary gateway answers on this machine. */
export function NotConnected() {
  return (
    <section className="card empty-state" aria-labelledby="nc-title">
      <div className="bird" aria-hidden>
        🐤
      </div>
      <h1 id="nc-title">No Canary gateway on this machine</h1>
      <p>
        The live view shows what your agent sends, as it happens. Start the gateway next to your agent, then come back to this tab. To check
        someone else's agent instead, use <b>Agent lookup</b>.
      </p>
      <code className="code">
        <span className="c"># from the canary repo</span>
        <br />
        npm install && npm run build
        <br />
        cd examples/viem-agent && npm run gateway
      </code>
    </section>
  );
}
