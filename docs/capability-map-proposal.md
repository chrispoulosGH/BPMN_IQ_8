# Proposed consolidated capability map

_Draft for review: nothing in the database has been changed._

## Summary

| | Today | Proposed |
|---|---|---|
| Levels | 1 (flat list) | 3: L1 area → L2 capability → today's capability kept as L3 |
| L1 capability areas | (10 domains, used as folders) | 10 |
| Capabilities at the grouping level | 97 | 35 L2 capabilities |
| Business flows covered | 100 | 100 (none dropped) |
| Flows per grouping capability | 92 with 1, 5 with 2 | 14 with 2, 13 with 3, 7 with 4, 1 with 5 |
| Average flows per grouping capability | 1.03 | 2.86 |

How it works: today's 97 capabilities are **kept** and become L3 (detail) capabilities, so no flow loses its link. Each one gets a parent L2 capability and an L1 area. The value-stream view would then group flows under the L2 capability instead of the L3 one, which is where the many-to-one fan-in shows up.

## Decisions needed

These go beyond regrouping: names that mean two things, duplicates, and moves across domains.

| Capability today | Finding |
|---|---|
| Inventory Management | Split: one name currently covers both parts reordering and new-vehicle inventory search. Proposed as "Parts Inventory Management" and "Vehicle Inventory Search & Locate". |
| Performance Management | Split: one name currently covers both employee reviews (HR) and dealer performance reviews. |
| Complaint Management | Merge candidate with "Issue Resolution": both are realized only by "Customer Complaint Resolution". |
| Issue Resolution | Merge candidate with "Complaint Management" (same single flow). |
| Training | Merge candidate with "Skills Development": both are realized only by "Dealer Staff Training Program". |
| Skills Development | Merge candidate with "Training" (same single flow). |
| Budgeting | Merge candidate with "Planning & Budgeting": two annual budget-planning flows sit in different domains (Finance & Insurance vs Corporate Functions). |
| Planning & Budgeting | Merge candidate with "Budgeting". |
| Customer Relations | Rename candidate: realized only by "Goodwill Repair Authorization". "Goodwill Management" says what it is. |
| Payables | Moves domain: accounts payable is an enterprise finance capability, not customer finance. |
| Contract Management | Moves domain: vendor contracts belong with procurement and supplier management. |
| GAP Coverage | Moves domain: GAP is sold alongside warranty / protection products in the F&I office. |
| Prototyping | Currently listed under two subdomains (Product Design and Product Development) for the same flow. |
| Event Management | Two auto-show event flows sit in different subdomains (Events and Marketing Operations); consolidate. |
| Collections | Overlaps "Delinquency Management" and "Payment Processing"; it is also the name of a subdomain. |

## Proposed map

### Product Engineering & Development

_3 L2 capabilities · 7 L3 · 7 business flows_

#### Vehicle Program Development — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Vehicle Development | Engineering & Product Development › Product Design | New Model Development Program |
| Prototyping ⚑ | Engineering & Product Development › Product Design<br>Engineering & Product Development › Product Development | Prototype Vehicle Build |
| Engineering Changes | Engineering & Product Development › Change Management | Engineering Change Order Process |

#### Product Validation & Testing — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Testing & Validation | Engineering & Product Development › Product Development | Product Validation Testing |
| Product Validation | Engineering & Product Development › Testing & Validation | Vehicle Validation Testing |

#### Vehicle Software & OTA — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Vehicle Software | Engineering & Product Development › Software Engineering | Vehicle Software Development |
| OTA Updates | Engineering & Product Development › Software Engineering | Over-the-Air Software Update |

### Manufacturing & Supply Chain

_5 L2 capabilities · 14 L3 · 14 business flows_

#### Production Planning & Scheduling — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Demand Forecasting | Manufacturing & Supply Chain › Production Planning | Production Planning Cycle |
| Production Scheduling | Manufacturing & Supply Chain › Production Operations | Daily Production Scheduling |

#### Production Execution — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Assembly Operations | Manufacturing & Supply Chain › Production Operations | Vehicle Assembly Line Execution |
| Line Management | Manufacturing & Supply Chain › Production Operations | Production Line Changeover |
| Maintenance | Manufacturing & Supply Chain › Plant Operations | Plant Equipment Maintenance |

#### Quality Management — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Inspection Process | Manufacturing & Supply Chain › Quality Management | End-of-Line Quality Inspection |
| Defect Management | Manufacturing & Supply Chain › Quality Management | Production Defect Containment |
| Safety Compliance | Manufacturing & Supply Chain › Quality Management | Vehicle Safety Compliance Certification |

#### Procurement & Supplier Management — 4 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Procurement | Manufacturing & Supply Chain › Supplier Management | Supplier Parts Ordering |
| Quality Assurance | Manufacturing & Supply Chain › Supplier Management | Supplier Quality Management |
| Supplier Audits | Manufacturing & Supply Chain › Supplier Management | Supplier Quality Audit |
| Contract Management ⚑ | Corporate Functions › Procurement | Vendor Contract Management |

#### Logistics & Distribution — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Warehouse Management | Manufacturing & Supply Chain › Inventory Control | Warehouse Inventory Management |
| Vehicle Distribution | Manufacturing & Supply Chain › Logistics | Vehicle Outbound Logistics |

### Vehicle Sales

_5 L2 capabilities · 15 L3 · 16 business flows_

#### Lead & Opportunity Management — 4 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Lead Management | Sales & Distribution › New Vehicle Sales | Digital Lead Capture & Qualification<br>Showroom Walk-In Engagement |
| Test Drive Management | Sales & Distribution › New Vehicle Sales | Test Drive Execution |
| Sales Recovery | Sales & Distribution › New Vehicle Sales | Lost Sales Recovery |

#### Vehicle Configuration & Ordering — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Vehicle Configuration | Sales & Distribution › New Vehicle Sales | Custom Vehicle Build Order |
| Inventory Management _(New Vehicle Sales)_ ⚑ | Sales & Distribution › New Vehicle Sales | Inventory Search & Locate |
| Online Purchase | Sales & Distribution › Digital Sales | Digital Retailing Journey |

#### Deal & Delivery Management — 4 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Pricing & Negotiation | Sales & Distribution › New Vehicle Sales | Deal Pricing & Structuring |
| Trade-In Management | Sales & Distribution › New Vehicle Sales | Trade-In Appraisal Process |
| Deal Closing | Sales & Distribution › New Vehicle Sales | Sales Contract Finalization |
| Vehicle Delivery | Sales & Distribution › New Vehicle Sales | New Vehicle Delivery Experience |

#### Fleet Sales Management — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Fleet Sales | Sales & Distribution › Fleet Management | Fleet Customer Sales Process |
| Fleet Account Management | Sales & Distribution › Fleet Sales | Fleet Proposal Generation |
| Fleet Order Processing | Sales & Distribution › Fleet Sales | Fleet Order Fulfillment |

#### Used Vehicle & Remarketing — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| CPO Certification | Sales & Distribution › Used Vehicle Sales | CPO Vehicle Certification Process |
| Remarketing | Sales & Distribution › Used Vehicle Sales | Wholesale Vehicle Disposition |

### Customer Finance

_3 L2 capabilities · 8 L3 · 8 business flows_

#### Retail Credit & Loan Origination — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Credit Processing | Finance & Insurance › Vehicle Financing | Customer Credit Application |
| Subprime Lending | Finance & Insurance › Vehicle Financing | Special Finance Processing |
| Loan Funding | Finance & Insurance › Vehicle Financing | Finance Contract Funding |

#### Lease Management — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Lease Origination | Finance & Insurance › Leasing | Vehicle Lease Structuring |
| Lease End Management | Finance & Insurance › Leasing | Lease Return & Disposition |

#### Customer Receivables & Collections — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Payment Processing | Finance & Insurance › Collections | Customer Payment Collection |
| Delinquency Management | Finance & Insurance › Collections | Past Due Account Management |
| Collections ⚑ | Finance & Insurance › Financial Operations | Accounts Receivable Collection |

### Warranty & Protection Products

_2 L2 capabilities · 6 L3 · 6 business flows_

#### Protection Product Sales — 4 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| GAP Coverage ⚑ | Finance & Insurance › Insurance Products | GAP Insurance Sale |
| Customer Engagement & Qualification | Warranty & Protection Services › Warranty Sales | Customer Warranty Interest Qualification |
| Product Presentation & Education | Warranty & Protection Services › Warranty Sales | Warranty Product Presentation & Recommendation |
| Pricing & Quote Management | Warranty & Protection Services › Warranty Sales | Warranty Pricing & Quote Generation |

#### Protection Contract Administration — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Contract Execution & Enrollment | Warranty & Protection Services › Contract Administration | Warranty Contract Execution |
| Customer Onboarding & Documentation | Warranty & Protection Services › Contract Administration | Warranty Customer Onboarding & Documentation |

### After-Sales & Service

_5 L2 capabilities · 16 L3 · 15 business flows_

#### Service Scheduling & Reception — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Appointment Management | After-Sales & Service › Service Operations | Service Appointment Scheduling |
| Vehicle Reception | After-Sales & Service › Service Operations | Vehicle Check-In Process |
| Quick Service | After-Sales & Service › Service Operations | Express Service Lane Process |

#### Service Delivery & Repair — 4 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Repair Execution | After-Sales & Service › Service Operations | Repair Order Completion |
| Mobile Service | After-Sales & Service › Service Operations | Mobile Service Delivery |
| Battery Services | After-Sales & Service › Vehicle Service | Battery Replacement Service |
| Tire Services | After-Sales & Service › Vehicle Service | Tire Replacement Service |

#### Parts Management — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Counter Sales | After-Sales & Service › Parts Operations | Parts Counter Sale |
| Inventory Management _(Parts Operations)_ ⚑ | After-Sales & Service › Parts Operations | Parts Reorder Process |
| Dealer Orders | Dealer Network Operations › Parts Distribution | Dealer Parts Order Processing |

#### Warranty Claims & Field Actions — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Claim Processing | After-Sales & Service › Warranty Service | Warranty Claim Submission |
| Customer Relations ⚑ | After-Sales & Service › Warranty Service | Goodwill Repair Authorization |
| Campaign Execution | After-Sales & Service › Recall Management | Recall Campaign Execution |

#### Customer Care — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Complaint Management ⚑ | After-Sales & Service › Customer Relations | Customer Complaint Resolution |
| Issue Resolution ⚑ | After-Sales & Service › Customer Support | Customer Complaint Resolution |
| Roadside Assistance | After-Sales & Service › Customer Support | Roadside Assistance Request |

### Connected Vehicle & Mobility

_3 L2 capabilities · 6 L3 · 7 business flows_

#### Connected Services Lifecycle — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Service Activation | Connected Vehicle & Mobility › Connected Services | Connected Services Activation |
| Subscription Management | Connected Vehicle & Mobility › Connected Services | Connected Subscription Renewal |
| Commerce Services | Connected Vehicle & Mobility › Connected Services | In-Vehicle Commerce Transaction |

#### Connected Vehicle Operations — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Vehicle Health | Connected Vehicle & Mobility › Telematics | Remote Vehicle Diagnostics |
| Cyber Defense | Connected Vehicle & Mobility › Vehicle Security | Vehicle Cybersecurity Incident Response |

#### EV Charging Services — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Charging Infrastructure | Connected Vehicle & Mobility › EV Services | EV Charging Network Integration<br>EV Charging Network Management |

### Dealer Network Management

_2 L2 capabilities · 6 L3 · 5 business flows_

#### Dealer Network Development — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Dealer Development | Dealer Network Operations › Dealer Management | New Dealer Onboarding |
| Training ⚑ | Dealer Network Operations › Dealer Development | Dealer Staff Training Program |
| Skills Development ⚑ | Dealer Network Operations › Training & Certification | Dealer Staff Training Program |

#### Dealer Performance & Standards — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Performance Management _(Dealer Management)_ ⚑ | Dealer Network Operations › Dealer Management | Dealer Performance Review |
| Compliance | Dealer Network Operations › Dealer Management | Dealer Standards Compliance Audit |
| Program Administration | Dealer Network Operations › Dealer Incentives | Dealer Incentive Program Management |

### Marketing & Customer Experience

_3 L2 capabilities · 9 L3 · 10 business flows_

#### Brand & Product Launch — 4 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Partnerships | Marketing & Customer Experience › Brand Management | Brand Partnership Activation |
| New Vehicle Launch | Sales & Distribution › Product Launch | New Model Launch to Market |
| Event Management ⚑ | Marketing & Customer Experience › Marketing Operations<br>Marketing & Customer Experience › Events | Auto Show & Event Marketing<br>Auto Show Event Management |

#### Campaign & Digital Marketing — 4 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Campaign Management | Marketing & Customer Experience › Marketing Operations | Marketing Campaign Planning |
| Online Advertising | Marketing & Customer Experience › Digital Marketing | Digital Advertising Campaign |
| Social Media | Marketing & Customer Experience › Digital Marketing | Social Media Customer Engagement |
| Retention Campaigns | After-Sales & Service › Service Marketing | Service Retention Campaign |

#### Customer Loyalty & Feedback — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Loyalty Management | Marketing & Customer Experience › Customer Engagement | Customer Loyalty Program |
| Feedback Management | Marketing & Customer Experience › Customer Experience | Customer Satisfaction Survey |

### Enterprise Management

_4 L2 capabilities · 12 L3 · 12 business flows_

#### Strategy & Financial Management — 5 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Strategic Planning | Corporate Functions › Corporate Strategy | Annual Strategic Planning Process |
| Planning & Budgeting ⚑ | Corporate Functions › Finance | Annual Budget Planning |
| Budgeting ⚑ | Finance & Insurance › Financial Planning | Annual Budget Planning Process |
| Financial Reporting | Corporate Functions › Finance | Monthly Financial Close |
| Payables ⚑ | Finance & Insurance › Financial Operations | Accounts Payable Processing |

#### Governance, Risk & Compliance — 3 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Regulatory Affairs | Corporate Functions › Compliance | Regulatory Compliance Reporting |
| Risk Assessment | Corporate Functions › Risk & Compliance | Enterprise Risk Assessment |
| Litigation Management | Corporate Functions › Legal | Legal Case Management |

#### Human Capital Management — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Talent Management | Corporate Functions › Human Resources | Employee Onboarding Process |
| Performance Management _(HR Services)_ ⚑ | Corporate Functions › HR Services | Employee Performance Review |

#### IT Service Management — 2 business flows

| L3 capability (today) | Today's domain › subdomain | Business flows |
|---|---|---|
| Service Management | Corporate Functions › Information Technology | IT Service Request Fulfillment |
| Change Management | Corporate Functions › IT Services | IT Change Request Process |

⚑ = listed under "Decisions needed".
