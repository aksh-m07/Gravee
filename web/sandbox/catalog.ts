/** Mirror of the PRODUCTS array in world/index.html. A test keeps the two in sync. */
export const CATALOG: { id: string; name: string; price: number }[] = [
  { id: "usbc", name: "USB-C Cable 2m", price: 12.99 },
  { id: "usbc2", name: "USB-C Cable 1m", price: 8.49 },
  { id: "lamp", name: "Black Desk Lamp", price: 34.0 },
  { id: "mouse", name: "Wireless Mouse", price: 19.95 },
  { id: "kb", name: "Mechanical Keyboard", price: 79.0 },
  { id: "mug", name: "Ceramic Mug", price: 11.5 },
  { id: "bottle", name: "Steel Water Bottle", price: 24.0 },
  { id: "notebook", name: "Dot Grid Notebook", price: 9.25 },
  { id: "headphones", name: "Headphones", price: 129.0 },
  { id: "charger", name: "65W Charger", price: 29.99 },
  { id: "webcam", name: "HD Webcam", price: 49.0 },
  { id: "stand", name: "Laptop Stand", price: 39.5 },
];
export const money = (n: number) => "$" + n.toFixed(2);
export const byName = (name: string) => CATALOG.find((p) => p.name.toLowerCase() === name.toLowerCase());
