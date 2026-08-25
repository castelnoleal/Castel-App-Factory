const MODEL = "gpt-5.6-luna";

export async function superviseBuild(env, spec) {
  if (!env.OPENAI_API_KEY) {
    return { enabled: false, approved: true, reason: "AI supervisor is not configured; deterministic validation remains authoritative." };
  }

  const tools = [{
    type: "function",
    function: {
      name: "approve_build",
      description: "Approve a build after checking the supplied app configuration. Only approve if the request is internally consistent and is a normal HTML/HTTPS-to-Android app build.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          reason: { type: "string" }
        },
        required: ["approved", "reason"],
        additionalProperties: false
      }
    }
  }];

  const payload = {
    model: MODEL,
    temperature: 0,
    tool_choice: { type: "function", function: { name: "approve_build" } },
    parallel_tool_calls: false,
    messages: [
      {
        role: "system",
        content: "You are the Castel App Factory build supervisor. Deterministic validation has already passed. Review only the supplied metadata. Approve ordinary website or HTML projects for Android packaging. Reject missing, contradictory, malformed, or obviously unsafe build metadata. Never invent values. The Worker, not the model, performs the actual build operation."
      },
      {
        role: "user",
        content: JSON.stringify({
          sourceType: spec.sourceType,
          sourceUrl: spec.sourceUrl || "",
          sourceFileName: spec.sourceFileName || "",
          appName: spec.appName,
          packageName: spec.packageName,
          versionName: spec.versionName,
          versionCode: spec.versionCode,
          orientation: spec.orientation,
          backNavigation: spec.backNavigation,
          zoom: spec.zoom,
          fullscreen: spec.fullscreen,
          externalLinks: spec.externalLinks
        })
      }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${data?.error?.message || text || "request failed"}`);

  const call = data?.choices?.[0]?.message?.tool_calls?.find(x => x?.function?.name === "approve_build");
  if (!call) throw new Error("AI supervisor returned no approval tool call.");

  let args;
  try { args = JSON.parse(call.function.arguments); } catch { throw new Error("AI supervisor returned invalid tool arguments."); }
  if (args.approved !== true) throw new Error(`AI supervisor rejected the build: ${args.reason || "No reason supplied."}`);

  return { enabled: true, approved: true, reason: String(args.reason || "Approved by AI supervisor."), model: MODEL };
}
