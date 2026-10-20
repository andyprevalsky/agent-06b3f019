import { PLANS } from "./plans.js";
import { renderPricingTable } from "./pricingTable.js";

document.getElementById("app").innerHTML = renderPricingTable(PLANS, { highlight: "team" });
