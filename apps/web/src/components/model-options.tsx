/**
 * The model `<option>`s of a picker, grouped by provider: with several
 * providers configured the list runs long, and the native picker's groups
 * keep it scannable (and searchable by typing on desktop).
 */
import type { ModelInfo } from "@spreissen/contracts";

/** Models grouped by provider, in the server's order (provider name, then label). */
export function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const group = groups.get(model.providerName) ?? [];
    group.push(model);
    groups.set(model.providerName, group);
  }
  return [...groups];
}

/** "3 models from Kenari" / "12 models from Anthropic, Kenari". */
export function catalogSummary(models: ModelInfo[]): string {
  const providers = groupByProvider(models).map(([name]) => name);
  const count = `${models.length} model${models.length === 1 ? "" : "s"}`;
  return `${count} from ${providers.join(", ")}`;
}

export function ModelOptions({ models }: { models: ModelInfo[] }) {
  const groups = groupByProvider(models);
  // One provider needs no group header.
  if (groups.length <= 1) {
    return models.map((model) => (
      <option key={model.id} value={model.id}>
        {model.label}
      </option>
    ));
  }
  return groups.map(([provider, group]) => (
    <optgroup key={provider} label={provider}>
      {group.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
    </optgroup>
  ));
}
