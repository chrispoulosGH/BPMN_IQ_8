const mongoose = require('mongoose');
const Diagram = require('./models/Diagram');

(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27018/bpmn_iq');
  const diagrams = await Diagram.find(
    {
      $or: [
        { domain: 'Sales Order Management', subdomain: 'Acquire Customer Offering(s)' },
        { domain: 'Sales Order Management', valueStream: 'Acquire Customer Offering(s)' },
        { subdomain: 'Acquire Customer Offering(s)' },
      ],
    },
    {
      name: 1,
      businessFlow: 1,
      valueStream: 1,
      journey: 1,
      domain: 1,
      subdomain: 1,
      capabilities: 1,
      neighborhoodName: 1,
    },
  ).lean();

  console.log(JSON.stringify(diagrams, null, 2));
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
