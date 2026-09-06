// ============================================================================
//  UHC Core - الطبقة الوحيدة اللي تلمس @minecraft/server-net
//  معزولة بملف: لو الموديول مو مسموح، الجسر بس يفصل واللعبة تكمل
// ============================================================================
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from "@minecraft/server-net";

export async function post(url, apiKey, bodyObj, timeoutSeconds) {
  const req = new HttpRequest(url);
  req.method = HttpRequestMethod.Post;
  req.headers = [
    new HttpHeader("Content-Type", "application/json"),
    new HttpHeader("x-uhc-key", apiKey),
  ];
  req.body = JSON.stringify(bodyObj ?? {});
  req.timeout = timeoutSeconds;               // ثواني
  const res = await http.request(req);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.body ? JSON.parse(res.body) : {};
}
