export default function handler(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    url: process.env.VITE_SUPABASE_URL || "",
    key: process.env.VITE_SUPABASE_ANON_KEY || ""
  });
}
