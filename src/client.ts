const DEFAULT_BASE_URL = "https://api.scaledown.xyz";

export class ScaledownError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "ScaledownError";
  }
}

export interface CompressResponse {
  compressed_prompt: string;
  original_prompt_tokens: number;
  compressed_prompt_tokens: number;
  successful: boolean;
  latency_ms: number;
  request_metadata: {
    compression_time_ms: number;
    compression_rate: string | number;
    prompt_length: number;
    compressed_prompt_length: number;
  };
}

// Wire shape of /compress/raw/: the success/token fields the plugin needs are
// nested under `results`, with aggregate totals duplicated at the top level.
interface RawCompressResponse {
  results?: {
    success?: boolean;
    successful?: boolean;
    compressed_prompt: string;
    original_prompt_tokens?: number;
    compressed_prompt_tokens?: number;
  };
  total_original_tokens?: number;
  total_compressed_tokens?: number;
  successful?: boolean;
  latency_ms?: number;
  request_metadata?: CompressResponse["request_metadata"];
  detail?: string;
}

export interface SummarizeResponse {
  summary: string;
  input_chars: number;
  output_chars: number;
  latency_ms: number;
}

export interface Label {
  name: string;
  rubric: string;
}

export interface ClassifyResponseLabel {
  label: string;
  score: number;
  rubric: string;
}

export interface ClassifyResponse {
  top_label: string;
  scores: Record<string, number>;
  labels: ClassifyResponseLabel[];
}

export interface EntityDefinition {
  description: string;
  threshold?: number;
  top_n?: number;
}

export type EntityMap = Record<string, string | EntityDefinition>;

export interface ExtractedEntity {
  text: string;
  type: string;
  confidence: number;
  start: number;
  end: number;
  context: string;
}

export interface ExtractResponse {
  entities: ExtractedEntity[];
}

export class ScaledownClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = process.env.SCALEDOWN_BASE_URL ?? DEFAULT_BASE_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "x-source": "kode",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ScaledownError(
        `Scaledown API error ${res.status}: ${res.statusText}`,
        res.status,
        text
      );
    }

    return res.json() as Promise<T>;
  }

  async compress(
    context: string,
    prompt: string,
    rate: number | "auto" = "auto"
  ): Promise<CompressResponse> {
    // The /compress/raw/ endpoint nests the per-prompt fields under `results`
    // while keeping aggregate/metadata fields at the top level. Flatten so
    // callers get a stable CompressResponse regardless of wire shape.
    const raw = await this.post<RawCompressResponse>("/compress/raw/", {
      context,
      prompt,
      scaledown: { rate },
    });
    // The endpoint returns HTTP 200 with a `{ detail }` body for input errors
    // (e.g. empty prompt) instead of a non-2xx status, so post() won't throw.
    if (raw.detail) {
      throw new ScaledownError(`Scaledown compress error: ${raw.detail}`, 200, raw.detail);
    }
    const results = raw.results;
    if (!results || typeof results.compressed_prompt !== "string") {
      throw new ScaledownError(
        "Scaledown compress error: unexpected response shape",
        200,
        JSON.stringify(raw).slice(0, 500)
      );
    }
    return {
      compressed_prompt: results.compressed_prompt,
      original_prompt_tokens:
        results.original_prompt_tokens ?? raw.total_original_tokens ?? 0,
      compressed_prompt_tokens:
        results.compressed_prompt_tokens ?? raw.total_compressed_tokens ?? 0,
      successful: raw.successful ?? results.successful ?? true,
      latency_ms: raw.latency_ms ?? 0,
      request_metadata: raw.request_metadata ?? {
        compression_time_ms: 0,
        compression_rate: rate,
        prompt_length: 0,
        compressed_prompt_length: 0,
      },
    };
  }

  async summarize(
    text: string,
    instructions?: string,
    maxTokens?: number,
    messages?: unknown[]
  ): Promise<SummarizeResponse> {
    return this.post<SummarizeResponse>("/summarization/abstractive", {
      text,
      ...(instructions !== undefined && { instructions }),
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
      // Structured message blocks (tool_use/tool_result included), sent
      // alongside the flattened `text` above so the backend can process tool
      // output structurally rather than relying only on the flattened text.
      ...(messages !== undefined && { messages }),
    });
  }

  async classify(text: string, labels: Label[]): Promise<ClassifyResponse> {
    return this.post<ClassifyResponse>("/classify", { text, labels });
  }

  async extract(
    text: string,
    entities: EntityMap,
    threshold?: number,
    topN?: number
  ): Promise<ExtractResponse> {
    return this.post<ExtractResponse>("/extract", {
      text,
      entities,
      ...(threshold !== undefined && { threshold }),
      ...(topN !== undefined && { top_n: topN }),
    });
  }
}
