// Must be first: loads .env before any other module reads process.env
import "dotenv/config";
import connectDB from "./db/index.js";
import { app } from "./app.js";
import { startStatusSweeper } from "./services/repoStatus.service.js";
import { logger } from "./utils/logger.js";

connectDB()
  .then(() => {
    // Fail runs left "processing" by a previous crash or restart
    startStatusSweeper();

    app.listen(process.env.PORT || 8000, () => {
      logger.info(`Server is running at port : ${process.env.PORT}`);
    });
  })
  .catch((error) => {
    logger.error("MongoDD connection Failed !!", error);
  });
