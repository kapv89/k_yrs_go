import axios from "axios";

const check = async (intervalMs: number, iters=10) => {
  if (iters === 0) {
    throw new Error('healthcheck failed')
  }

  try {
    await axios.get(`http://127.0.0.1:3000/healthz`)
  } catch (err) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    await check(intervalMs, iters-1);
  }
}

check(3000);