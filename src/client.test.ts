import { jest } from "@jest/globals";
import { ScaledownClient, ScaledownError } from "./client.js";

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

function mockOk(body: unknown) {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body)));
}

function mockError(status: number, text = "") {
  mockFetch.mockResolvedValueOnce(new Response(text, { status, statusText: String(status) }));
}

const client = new ScaledownClient("test-key");

beforeEach(() => mockFetch.mockClear());

describe("compress", () => {
  it("posts to /compress/raw/ and flattens the nested results shape", async () => {
    // Real wire shape: per-prompt fields nested under `results`.
    const body = {
      results: {
        success: true,
        compressed_prompt: "compressed",
        original_prompt_tokens: 100,
        compressed_prompt_tokens: 30,
        compression_ratio: 0.3,
      },
      total_original_tokens: 100,
      total_compressed_tokens: 30,
      successful: true,
      latency_ms: 100,
      request_metadata: {
        compression_time_ms: 100,
        compression_rate: 0.3,
        prompt_length: 400,
        compressed_prompt_length: 120,
      },
    };
    mockOk(body);
    const result = await client.compress("ctx", "prompt", 0.3);
    expect(result.compressed_prompt).toBe("compressed");
    expect(result.original_prompt_tokens).toBe(100);
    expect(result.compressed_prompt_tokens).toBe(30);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.scaledown.xyz/compress/raw/",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "test-key" }),
      })
    );
  });

  it("throws ScaledownError on 401", async () => {
    mockError(401, "unauthorized");
    await expect(client.compress("ctx", "q")).rejects.toBeInstanceOf(
      ScaledownError
    );
  });

  it("throws ScaledownError on 429", async () => {
    mockError(429);
    await expect(client.compress("ctx", "q")).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("summarize", () => {
  it("posts to /summarization/abstractive", async () => {
    mockOk({ summary: "short", input_chars: 100, output_chars: 5, latency_ms: 50 });
    const result = await client.summarize("long text", "Use bullets.");
    expect(result.summary).toBe("short");
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.instructions).toBe("Use bullets.");
  });

  it("omits optional fields when not provided", async () => {
    mockOk({ summary: "s", input_chars: 10, output_chars: 1, latency_ms: 10 });
    await client.summarize("text");
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.instructions).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });
});

describe("classify", () => {
  it("posts to /classify and returns top_label", async () => {
    mockOk({
      top_label: "medical",
      scores: { medical: 0.9, legal: 0.1 },
      labels: [
        { label: "medical", score: 0.9, rubric: "Is this medical?" },
        { label: "legal", score: 0.1, rubric: "Is this legal?" },
      ],
    });
    const result = await client.classify("patient has fever", [
      { name: "medical", rubric: "Is this medical?" },
      { name: "legal", rubric: "Is this legal?" },
    ]);
    expect(result.top_label).toBe("medical");
  });
});

describe("extract", () => {
  it("posts to /extract and returns entities", async () => {
    const entities = [
      {
        text: "Henry Wang",
        type: "Name",
        confidence: 0.99,
        start: 0,
        end: 10,
        context: "Henry Wang ...",
      },
    ];
    mockOk({ entities });
    const result = await client.extract("Henry Wang is a dev", {
      Name: "Full name",
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].text).toBe("Henry Wang");
  });

  it("passes threshold and top_n when provided", async () => {
    mockOk({ entities: [] });
    await client.extract("text", { Name: "name" }, 0.8, 3);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.threshold).toBe(0.8);
    expect(body.top_n).toBe(3);
  });
});
