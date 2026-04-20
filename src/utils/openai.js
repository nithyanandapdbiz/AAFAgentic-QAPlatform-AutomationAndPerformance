/**
 * OpenAI utility — thin wrapper around the OpenAI Chat Completions API.
 * Uses axios (already a project dependency) so no extra packages are needed.
 */
const axios = require("axios");
const logger = require("./logger");

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Send a chat completion request to OpenAI.
 * @param {string} systemPrompt - system-level instruction
 * @param {string} userPrompt   - the user/task prompt
 * @param {object} [opts]       - optional overrides (temperature, max_tokens)
 * @returns {string} the assistant's message content
 */
async function chat(systemPrompt, userPrompt, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY not set — skipping LLM call");
    return null;
  }

  const payload = {
    model: opts.model || MODEL,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.max_tokens ?? 4096,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  try {
    const { data } = await axios.post(OPENAI_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    });
    return data.choices[0].message.content.trim();
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`OpenAI API error (${status}): ${msg}`);
    return null;
  }
}

/**
 * Send a chat completion request and parse the response as JSON.
 * Returns null if the LLM is unavailable or responds with invalid JSON.
 */
async function chatJSON(systemPrompt, userPrompt, opts = {}) {
  const raw = await chat(systemPrompt, userPrompt, opts);
  if (!raw) return null;

  try {
    // Strip markdown code fences if the model wraps JSON in ```json ... ```
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    return JSON.parse(cleaned);
  } catch (err) {
    logger.warn(`Failed to parse LLM JSON response: ${err.message}`);
    logger.debug(`Raw LLM response:\n${raw}`);
    return null;
  }
}

module.exports = { chat, chatJSON };
