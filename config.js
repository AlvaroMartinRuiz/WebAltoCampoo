// Configuración de Vive Alto Campoo.
// Edita este archivo para cambiar actividades, horarios, plazas y precios.

window.VAC_CONFIG = {
  // Días que se pueden reservar hacia delante.
  bookingWindowDays: 90,

  // Almacenamiento de reservas:
  //  - Sin Supabase: se guardan en el navegador (solo sirve como demo).
  //  - Con Supabase: reservas compartidas entre todos los visitantes.
  //    Rellena url y anonKey (ver README.md).
  supabase: {
    url: "",
    anonKey: "",
  },

  services: [
    {
      id: "senderismo",
      name: "Ruta de senderismo guiada",
      emoji: "🥾",
      description: "Recorrido por hayedos y praderías hasta el Pico Tres Mares. Nivel medio.",
      duration: "4 h",
      price: 25,
      capacity: 12,
      slots: ["09:30", "15:30"],
      days: [0, 1, 2, 3, 4, 5, 6], // 0 = domingo … 6 = sábado
    },
    {
      id: "caballo",
      name: "Paseo a caballo",
      emoji: "🐎",
      description: "Paseo tranquilo por el valle con caballos mansos. Apto para principiantes.",
      duration: "2 h",
      price: 40,
      capacity: 6,
      slots: ["10:00", "12:30", "17:00"],
      days: [2, 3, 4, 5, 6, 0],
    },
    {
      id: "ebike",
      name: "Ruta en bici eléctrica",
      emoji: "🚵",
      description: "Pistas y caminos alrededor del embalse del Ebro. Incluye bici y casco.",
      duration: "3 h",
      price: 45,
      capacity: 8,
      slots: ["10:00", "16:00"],
      days: [5, 6, 0],
    },
    {
      id: "raquetas",
      name: "Raquetas de nieve",
      emoji: "❄️",
      description: "Excursión invernal por la estación de Alto Campoo. Material incluido.",
      duration: "3 h",
      price: 35,
      capacity: 10,
      slots: ["10:00"],
      days: [0, 1, 2, 3, 4, 5, 6],
      months: [12, 1, 2, 3], // solo en temporada de nieve
    },
  ],
};
