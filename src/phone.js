export function formatPhone(raw) {
  let num = String(raw).replace(/\D/g, "");

  if (num.startsWith("0")) {
    num = "62" + num.slice(1);
  } else if (num.startsWith("8")) {
    num = "62" + num;
  }

  return num + "@s.whatsapp.net";
}

export function displayPhone(raw) {
  let num = String(raw).replace(/\D/g, "");
  if (num.startsWith("0")) {
    num = "62" + num.slice(1);
  } else if (num.startsWith("8")) {
    num = "62" + num;
  }
  return "+" + num;
}
