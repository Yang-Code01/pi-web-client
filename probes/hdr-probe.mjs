import http from "node:http";
const srv = http.createServer((req,res)=>{
  const h = JSON.stringify({
    peer: req.socket.remoteAddress,
    cf: req.headers["cf-connecting-ip"] ?? null,
    xff: req.headers["x-forwarded-for"] ?? null,
    xfp: req.headers["x-forwarded-proto"] ?? null,
    host: req.headers.host ?? null,
    ua: (req.headers["user-agent"]||"").slice(0,30),
  });
  console.error("REQ", h);
  res.end("ok\n");
});
srv.listen(7865, "127.0.0.1", ()=>console.error("listening 7865"));
setTimeout(()=>process.exit(0), 75000);
