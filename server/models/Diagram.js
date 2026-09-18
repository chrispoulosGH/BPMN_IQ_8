const mongoose = require('mongoose');
const { DEFAULT_NEIGHBORHOOD_NAME } = require('../utils/neighborhoodScope');

const diagramSchema = new mongoose.Schema(
  {
    neighborhoodName: {
      type: String,
      required: true,
      trim: true,
      default: DEFAULT_NEIGHBORHOOD_NAME,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    xml: {
      type: String,
      required: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    version: {
      type: Number,
      default: 1,
    },
    fileName: {
      type: String,
      default: null,
    },
    capabilities: {
      type: [
        {
          capabilityId: Number,
          capabilityName: String,
          confidence: Number,
          justification: String,
        },
      ],
      default: [],
    },
    changeHistory: {
      type: [
        {
          date: { type: Date, default: Date.now },
          userId: { type: String, required: true },
          note: { type: String, required: true },
        },
      ],
      default: [],
    },
    tasks: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          source: { type: String, default: null, trim: true },
          target: { type: String, default: null, trim: true },
          actor: { type: String, default: null, trim: true },
          applications: [
            {
              name: { type: String, required: true, trim: true },
              correlationId: { type: String, default: null, trim: true },
            },
          ],
        },
      ],
      default: [],
    },
    businessCapability: { type: String, default: null, trim: true },
    valueStream: { type: String, default: null, trim: true },
    journey: { type: String, default: null, trim: true },
    // Parsed from <bpmndi:BPMNDiagram name="..."> on save
    lineOfBusiness: { type: String, default: null },
    channel: { type: String, default: null },
    domain: { type: String, default: null },
    subdomain: { type: String, default: null },
    product: { type: String, default: null },
    businessFlow: { type: String, default: null },
    status: { type: String, default: 'draft', trim: true },
    sourcedFrom: { type: String, default: null, trim: true },
    owner: { type: String, default: null, trim: true },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
    // Sticky notes pinned onto this diagram's canvas (Diagrams tab). Position
    // (dx/dy) is stored relative to the diagram's own content anchor — the
    // same top-left anchor point the client uses for its canvas-anchored
    // title banner — rather than as absolute canvas coordinates, so a note
    // stays put on its diagram's content whether that diagram is viewed
    // alone or stacked alongside others on the composite canvas.
    notes: {
      type: [
        {
          id: { type: String, required: true },
          text: { type: String, default: '' },
          color: { type: String, default: '#fff59d' },
          dx: { type: Number, default: 0 },
          dy: { type: Number, default: 0 },
          createdBy: { type: String, default: null, trim: true },
          createdAt: { type: Date, default: Date.now },
          updatedBy: { type: String, default: null, trim: true },
          updatedAt: { type: Date, default: Date.now },
          // Append-only audit trail — one entry per create/edit/color-change/
          // move, oldest first. Rendered on the note itself (see
          // BpmnEditor.tsx's StickyNoteCard) so who-did-what-when is visible
          // without leaving the canvas.
          history: {
            type: [
              {
                userId: { type: String, required: true, trim: true },
                date: { type: Date, default: Date.now },
                change: { type: String, required: true, trim: true },
              },
            ],
            default: [],
            _id: false,
          },
        },
      ],
      default: [],
      _id: false,
    },
  },
  { timestamps: true }
);

diagramSchema.index({ neighborhoodName: 1, name: 1 }, { unique: true });

// Text index for search across all metadata fields
diagramSchema.index({
  name: 'text',
  description: 'text',
  tags: 'text',
  'tasks.name': 'text',
  'tasks.actor': 'text',
  'tasks.applications.name': 'text',
  lineOfBusiness: 'text',
  channel: 'text',
  domain: 'text',
  subdomain: 'text',
  product: 'text',
  valueStream: 'text',
  journey: 'text',
  businessFlow: 'text',
  businessCapability: 'text',
  status: 'text',
  createdBy: 'text',
  updatedBy: 'text',
});

// Multikey indexes for efficient cross-diagram task/app lookups
diagramSchema.index({ 'tasks.name': 1 });
diagramSchema.index({ 'tasks.actor': 1 });
diagramSchema.index({ 'tasks.applications.name': 1 });
diagramSchema.index({ 'tasks.name': 1, businessFlow: 1 });

module.exports = mongoose.model('Diagram', diagramSchema);
