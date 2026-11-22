import 'dotenv/config';
import app from './src/app.js';
import { env } from './src/config/env.js';

const port = env.port;

app.listen(port, () => {
    console.log(`E-Barangay server running at ${env.appUrl} (port ${port})`);
});
