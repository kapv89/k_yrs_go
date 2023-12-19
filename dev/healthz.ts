import axios from "axios";

const check = async () => {
  try {
    await axios.get('http://localhost:5050')
  } catch (err) {
    await new Promise(resolve => setTimeout(resolve));
    await check();
  }
}

check();