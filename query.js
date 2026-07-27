const { MongoClient } = require('mongodb');
(async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27018');
  await client.connect();
  const db = client.db('bpmn_iq');

  const neighborhood = 'AT&T Journey';
  const term = /customer\s*winback/i;

  // 1. canonicalcomponents
  console.log('--- canonicalcomponents ---');
  const ccDocs = await db.collection('canonicalcomponents').find({
    neighborhoodName: neighborhood,
    $or: [{ componentType: term }, { primaryKey: term }]
  }).toArray();
  console.log('Count:', ccDocs.length);
  ccDocs.forEach(d => {
    const valKeys = d.values ? Object.keys(d.values) : [];
    const hasLineage = valKeys.includes('__lineage');
    const hasLineageVariants = valKeys.includes('__lineageVariants');
    console.log(JSON.stringify({
      componentType: d.componentType,
      primaryKey: d.primaryKey,
      parentRefsCount: d.parentRefs ? d.parentRefs.length : 0,
      sourceBatchesCount: d.sourceBatches ? d.sourceBatches.length : 0,
      sampleValuesKeys: valKeys,
      hasLineage,
      hasLineageVariants
    }, null, 2));
  });

  // 2. components
  console.log('\n--- components ---');
  const compDocs = await db.collection('components').find({
    neighborhoodName: neighborhood,
    $or: [
      { name: term },
      { 'rows.values.name': term }
    ]
  }).toArray();
  console.log('Count:', compDocs.length);
  compDocs.forEach(d => {
    const matchingRows = (d.rows || []).filter(r => {
      const nameVal = r.values && r.values.name;
      return typeof nameVal === 'string' && term.test(nameVal);
    });
    console.log(JSON.stringify({
      componentName: d.name,
      matchingRows: matchingRows.map(r => ({
        rowValuesName: r.values ? r.values.name : undefined,
        parentName: r.parentName || r.values?.parentName,
        parentFactoryName: d.parentFactoryName,
        sourcedFrom: r.sourcedFrom || r.values?.sourcedFrom || d.sourcedFrom
      }))
    }, null, 2));
  });

  // 3. componentSearchIndex (called componentsearchindices in query, collections lists componentSearchIndex)
  console.log('\n--- componentSearchIndex ---');
  const idxDocs = await db.collection('componentSearchIndex').find({
    neighborhoodName: neighborhood,
    $or: [
      { componentName: term },
      { rowName: term }
    ]
  }).toArray();
  console.log('Count:', idxDocs.length);
  console.log(JSON.stringify(idxDocs.map(d => ({ componentName: d.componentName, rowName: d.rowName })), null, 2));

  // 4. dataComponentBatches
  console.log('\n--- dataComponentBatches ---');
  const batchDocs = await db.collection('dataComponentBatches').find({
    neighborhoodName: neighborhood,
    $or: [
      { name: term },
      { componentType: term },
      { 'rows.values.name': term }
    ]
  }).toArray();
  console.log('Count:', batchDocs.length);
  batchDocs.forEach(d => {
    const matchingRows = (d.rows || []).map((r, i) => ({ r, i })).filter(({ r }) => {
      const nameVal = r.values && r.values.name;
      return typeof nameVal === 'string' && term.test(nameVal);
    });
    console.log(JSON.stringify({
      _id: d._id,
      name: d.name,
      componentType: d.componentType,
      sourceFileName: d.sourceFileName,
      matchingRows: matchingRows.map(x => ({
        rowIndex: x.r.rowIndex !== undefined ? x.r.rowIndex : x.i,
        rowValuesName: x.r.values ? x.r.values.name : undefined
      }))
    }, null, 2));
  });

  await client.close();
})().catch(console.error);
