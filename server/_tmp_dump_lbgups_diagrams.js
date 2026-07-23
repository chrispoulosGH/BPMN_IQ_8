const mongoose = require('mongoose');
const Diagram = require('./models/Diagram');

(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27018/bpmn_iq');
  const diagrams = await Diagram.find(
    { neighborhoodName: 'LBGUPS' },
    { name: 1, businessFlow: 1, valueStream: 1, journey: 1, domain: 1, subdomain: 1, capabilities: 1 }
  ).lean();
  console.log('COUNT', diagrams.length);
  console.log(JSON.stringify(diagrams.slice(0, 50), null, 2));
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
