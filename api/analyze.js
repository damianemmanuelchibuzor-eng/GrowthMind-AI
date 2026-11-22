// GrowthMind AI – YouTube link analyzer (Vercel serverless function)
// Env vars: YOUTUBE_API_KEY (required), ANTHROPIC_API_KEY (optional, enables AI coaching)
const YT = "https://www.googleapis.com/youtube/v3";

async function yt(path, params) {
  const u = new URL(YT + "/" + path);
  Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "YouTube API error");
  return j;
}

function parseLink(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input); } catch (e) { return null; }
  const h = u.hostname.replace(/^www\.|^m\./, "");
  const p = u.pathname.split("/").filter(Boolean);
  if (h === "youtu.be") return p[0] ? { video: p[0] } : null;
  if (h !== "youtube.com") return null;
  if (p[0] === "watch") return u.searchParams.get("v") ? { video: u.searchParams.get("v") } : null;
  if (["shorts", "live", "embed"].includes(p[0]) && p[1]) return { video: p[1] };
  if (p[0] === "channel" && p[1]) return { id: p[1] };
  if (p[0] && p[0].startsWith("@")) return { handle: p[0] };
  if (p[0] === "user" && p[1]) return { username: p[1] };
  return null;
}

async function getChannel(ref) {
  const part = "snippet,statistics,contentDetails";
  if (ref.video) {
    const v = await yt("videos", { part: "snippet", id: ref.video });
    if (!v.items || !v.items.length) throw new Error("Video not found.");
    ref = { id: v.items[0].snippet.channelId };
  }
  const q = ref.id ? { id: ref.id } : ref.handle ? { forHandle: ref.handle } : { forUsername: ref.username };
  const c = await yt("channels", { part, ...q });
  if (!c.items || !c.items.length) throw new Error("Channel not found. Check the link.");
  return c.items[0];
}

const secs = (iso) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "") || [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
};
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Requirements are checked against YouTube's published rules (Nov 2026). Higher tier changes on 1 Feb 2027.
function rules() {
  const next = Date.now() >= Date.UTC(2027, 1, 1);
  return { next, fan: { subs: 500, uploads: 3, hours: 3000, shorts: 3e6 }, ads: { subs: 1000, hours: next ? 8000 : 4000, shorts: next ? 2e7 : 1e7 } };
}

async function aiCoach(data) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 900,
        system: "You are a careful YouTube growth advisor. Use only the data given. Never promise views, virality or income, never claim to know the algorithm, and never suggest fake engagement or policy workarounds. Reply with JSON only: {\"summary\":string,\"priorities\":[{\"title\":string,\"why\":string,\"action\":string}],\"next7days\":[string]} with 3 priorities and 4 to 5 next7days items.",
        messages: [{ role: "user", content: JSON.stringify(data) }]
      })
    });
    const j = await r.json();
    const t = (j.content && j.content[0] && j.content[0].text || "").replace(/```json|```/g, "").trim();
    return JSON.parse(t);
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!process.env.YOUTUBE_API_KEY) return res.status(500).json({ error: "Server is missing YOUTUBE_API_KEY." });
  try {
    const url = String((req.body && req.body.url) || "").trim().slice(0, 300);
    const ref = parseLink(url);
    if (!ref) return res.status(400).json({ error: "Paste a YouTube channel (@handle) or video link." });

    const ch = await getChannel(ref);
    const st = ch.statistics, sn = ch.snippet;
    const subs = st.hiddenSubscriberCount ? null : +st.subscriberCount;
    const pl = await yt("playlistItems", { part: "contentDetails", playlistId: ch.contentDetails.relatedPlaylists.uploads, maxResults: 30 });
    const ids = pl.items.map((i) => i.contentDetails.videoId).join(",");
    const vids = ids ? (await yt("videos", { part: "snippet,statistics,contentDetails", id: ids })).items : [];

    const now = Date.now(), day = 864e5;
    const list = vids.map((v) => ({
      title: v.snippet.title, date: v.snippet.publishedAt, dur: secs(v.contentDetails.duration),
      views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0
    }));
    const recent = list.filter((v) => now - new Date(v.date) < 90 * day);
    const shortsRecent = recent.filter((v) => v.dur <= 180);
    const eng = list.filter((v) => v.views > 0).map((v) => (v.likes + v.comments) / v.views);
    const lastUpload = list.length ? Math.round((now - Math.max(...list.map((v) => +new Date(v.date)))) / day) : null;
    const m = {
      subs, totalViews: +st.viewCount, videoCount: +st.videoCount,
      channelAgeDays: Math.round((now - new Date(sn.publishedAt)) / day),
      uploads90: recent.length, daysSinceLastUpload: lastUpload,
      medianViews: Math.round(median(list.map((v) => v.views))),
      engagementPct: +(median(eng) * 100).toFixed(2),
      shortsShare: list.length ? Math.round((list.filter((v) => v.dur <= 180).length / list.length) * 100) : 0,
      shortsViews90: shortsRecent.reduce((a, v) => a + v.views, 0),
      sampled: list.length
    };

    const R = rules();
    const cmp = (have, need) => (have === null ? "unknown" : have >= need ? "met" : "not_met");
    const checks = [
      { label: "Subscribers for fan funding (memberships)", need: R.fan.subs, have: subs, status: cmp(subs, R.fan.subs) },
      { label: "Subscribers for ad revenue", need: R.ads.subs, have: subs, status: cmp(subs, R.ads.subs) },
      { label: "3 public uploads in last 90 days", need: R.fan.uploads, have: m.uploads90, status: cmp(m.uploads90, R.fan.uploads) },
      { label: "Qualified watch hours (4,000" + (R.next ? "; 8,000 for new applicants" : "; rising to 8,000 on 1 Feb 2027") + ")", status: "owner_only", note: "Only the owner can see this in YouTube Studio." },
      { label: "Shorts views, last 90 days (" + (R.ads.shorts / 1e6) + "M needed)", status: "owner_only", note: "Public views on recent Shorts add up to about " + m.shortsViews90.toLocaleString("en-US") + ", but qualified views are in YouTube Studio." },
      { label: "No active Community Guidelines strikes; follows monetization policies", status: "owner_only", note: "Check Studio → Content and Policy → Channel status." }
    ];

    const obs = [];
    if (lastUpload !== null && lastUpload > 30) obs.push("No upload for " + lastUpload + " days. Long gaps make it harder to build a viewing habit.");
    if (m.uploads90 < 12) obs.push("Only " + m.uploads90 + " uploads in 90 days (under one per week). A steady rhythm you can keep matters more than volume.");
    if (subs && m.medianViews < subs * 0.02) obs.push("The typical video gets about " + m.medianViews.toLocaleString("en-US") + " views, under 2% of subscribers. Titles, topics and openings are worth testing.");
    if (m.engagementPct && m.engagementPct < 1) obs.push("Likes plus comments are about " + m.engagementPct + "% of views. Ask clearer questions and give viewers a reason to respond.");
    if (!obs.length) obs.push("No obvious public red flags in the latest " + m.sampled + " videos. Keep reviewing weekly.");

    const ai = await aiCoach({ channel: sn.title, metrics: m, rulesNow: R, topVideos: list.slice(0, 15).map((v) => ({ title: v.title, views: v.views, seconds: v.dur })) });
    res.status(200).json({
      channel: { title: sn.title, handle: sn.customUrl || "", thumb: sn.thumbnails && (sn.thumbnails.default || {}).url, url: "https://www.youtube.com/channel/" + ch.id },
      metrics: m, checks, observations: obs, ai, asOf: new Date().toISOString().slice(0, 10)
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Something went wrong." });
  }
};
