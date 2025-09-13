export default function handler(req, res) {
  res.status(200).json({ ok: true, esm: true, node: process.version });
}
