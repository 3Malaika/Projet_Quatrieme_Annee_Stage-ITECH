import { config } from "./config/env.js";
import app from "./app.js";

app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
