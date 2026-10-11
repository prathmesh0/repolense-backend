import dotenv from "dotenv";
import connectDB from "./db/index.js";
import { app } from "./app.js";
import { startStatusSweeper } from "./services/repoStatus.service.js";

dotenv.config({
  path: "./.env",
});

connectDB()
  .then(() => {
    // Fail runs left "processing" by a previous crash or restart
    startStatusSweeper();

    app.listen(process.env.PORT || 8000, () => {
      console.log(`Server is running at port : ${process.env.PORT}`);
    });
  })
  .catch((error) => {
    console.error("MongoDD connection Failed !!", error);
  });
