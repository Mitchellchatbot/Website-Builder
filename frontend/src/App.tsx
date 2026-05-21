import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import LeadsPage from "./pages/LeadsPage";
import ResultPage from "./pages/ResultPage";
import HistoryPage from "./pages/HistoryPage";
import BatchPage from "./pages/BatchPage";
import ActivePage from "./pages/ActivePage";
import DashboardPage from "./pages/DashboardPage";
import CustomLinksPage from "./pages/CustomLinksPage";
import WebsitesPage from "./pages/WebsitesPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/leads" replace />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/result/:leadWebsiteId" element={<ResultPage />} />
          <Route path="/batch/:ids" element={<BatchPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/active" element={<ActivePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/custom-links" element={<CustomLinksPage />} />
          <Route path="/websites" element={<WebsitesPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
