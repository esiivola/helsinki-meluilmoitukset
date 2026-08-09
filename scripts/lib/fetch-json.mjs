const USER_AGENT = 'HelsinkiNoiseNotices/1.0 (+https://esiivola.github.io/helsinki-meluilmoitukset/)';

export async function fetchJson(url, timeoutMs = 45000, options = {}, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...options.headers },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    return fetchJson(url, timeoutMs, options, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}
