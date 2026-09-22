/**
 * Counters and gauges, rendered in Prometheus text format.
 *
 * Deliberately a few dozen lines rather than a dependency: the service needs to answer four
 * questions -- is it alive, is it keeping up, is it winning races, is it being rate-limited --
 * and each is one counter. Anything richer belongs in whatever scrapes this.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly help = new Map<string, string>();
  readonly startedAt = Date.now();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  /** Exposed so tests can assert behaviour through the same surface a scraper sees. */
  value(name: string, labels: Record<string, string> = {}): number {
    const key = seriesKey(name, labels);
    return this.counters.get(key) ?? this.gauges.get(key) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();
    const write = (series: Map<string, number>, type: string) => {
      for (const [key, value] of series) {
        const name = key.split("{")[0];
        if (!emitted.has(name)) {
          emitted.add(name);
          const h = this.help.get(name);
          if (h) lines.push(`# HELP ${name} ${h}`);
          lines.push(`# TYPE ${name} ${type}`);
        }
        lines.push(`${key} ${value}`);
      }
    };
    write(this.counters, "counter");
    write(this.gauges, "gauge");
    lines.push(`memokit_executor_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    return lines.join("\n") + "\n";
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([k, v]) => `${k}="${escape(v)}"`).join(",")}}`;
}

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
