import { Routes, Route, Navigate } from 'react-router'
import Login from './pages/Login'
import Privacy from './pages/Privacy'
import Terms from './pages/Terms'
import Store from './pages/Store'
import Cart from './pages/Cart'
import Pay from './pages/Pay'
import Orders from './pages/Orders'
import Wallet from './pages/Wallet'
import CustomerSettings from './pages/CustomerSettings'
import CustomerLayout from './pages/CustomerLayout'
import AdminLayout from './pages/admin/AdminLayout'
import Dashboard from './pages/admin/Dashboard'
import Sales from './pages/admin/Sales'
import SalesPeople from './pages/admin/SalesPeople'
import Items from './pages/admin/Items'
import Users from './pages/admin/Users'
import Settings from './pages/admin/Settings'
import AdminOrders from './pages/admin/AdminOrders'
import Restock from './pages/admin/Restock'
import Topups from './pages/admin/Topups'
import { RequireAuth, RequireAdmin, HomeRedirect } from './components/guards'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/" element={<HomeRedirect />} />
      <Route element={<RequireAuth><CustomerLayout /></RequireAuth>}>
        <Route path="/store" element={<Store />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/wallet" element={<Wallet />} />
        <Route path="/settings" element={<CustomerSettings />} />
      </Route>
      <Route path="/cart" element={<RequireAuth><Cart /></RequireAuth>} />
      <Route path="/pay/:orderId" element={<RequireAuth><Pay /></RequireAuth>} />
      <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
        <Route index element={<Dashboard />} />
        <Route path="sales" element={<Sales />} />
        <Route path="sales/people" element={<SalesPeople />} />
        <Route path="items" element={<Items />} />
        <Route path="users" element={<Users />} />
        <Route path="settings" element={<Settings />} />
        <Route path="payments" element={<Navigate to="/admin/settings" replace />} />
        <Route path="orders" element={<AdminOrders />} />
        <Route path="topups" element={<Topups />} />
        <Route path="restock" element={<Restock />} />
      </Route>
    </Routes>
  )
}
